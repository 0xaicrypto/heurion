import type { Node as PMNode } from 'prosemirror-model'
import { locate, threadMarks } from '../model/anchors.ts'
import { indexById } from '../model/ids.ts'
import { serializeBlock } from '../model/markdown.ts'
import type { Documents, NodeChange } from '../model/runtime.ts'
import type { Actor } from '../store/db.ts'
import { randomBytes } from 'node:crypto'
import { applyOps, type OpResult } from './apply.ts'
import { toSuggestion } from './suggest.ts'
import { DOI, manualCitation } from './citation-check.ts'
import { OpError, opTexts, targetIds, type EditBatch } from './types.ts'

export interface EditResult {
  doc_id: string
  rev: number
  results: OpResult[]
  changes: NodeChange[]
}


/**
 * 操作层（PLATFORM.md §5）：唯一的 MCP 写入口。
 * 管线：schema 校验（zod，在接入层）→ 守卫 → 内存应用 → 单个 Yjs 事务提交 → op log。
 * 守卫只对 AI（MCP）硬拦截；用户写入不受冲突、引用、锚点守卫阻挡（用户优先）。
 */
export class OpService {
  constructor(private readonly docs: Documents) {}

  edit(batch: EditBatch, meta: { actor: Actor; turnId: string | null }): EditResult {
    const store = this.docs.store
    const row = store.getDoc(batch.doc_id)
    if (!row) throw new OpError('doc_not_found', `文档 ${batch.doc_id} 不存在`)
    if (row.kind !== 'doc') throw new OpError('unsupported_kind', 'doc_edit 只能编辑 doc 类型文档')
    // 先落掉尚未落库的浏览器编辑：冲突守卫要看到用户最新的改动
    this.docs.flush(batch.doc_id)
    const rev = this.docs.rev(batch.doc_id)
    if (batch.base_rev > rev) {
      throw new OpError('invalid_base_rev', `base_rev ${batch.base_rev} 大于当前 rev ${rev}`, { hint: '使用 doc_outline / doc_read 返回的 rev。' })
    }
    const before = this.docs.get(batch.doc_id)
    const ai = meta.actor === 'ai'

    this.guardPending(batch, before)
    if (ai) {
      this.guardConflicts(batch, before)
      this.guardCitations(batch)
    }

    const applied = applyOps(before, batch.ops, { taken: this.docs.takenIds(batch.doc_id) })
    const results = applied.results
    const after = batch.mode === 'suggest'
      ? toSuggestion(before, applied.doc, `g${randomBytes(4).toString('hex')}`)
      : applied.doc

    if (ai) this.guardAnchors(batch, before, after)

    const event = this.docs.commit(batch.doc_id, after, { actor: meta.actor, turnId: meta.turnId, ops: batch.ops })
    return { doc_id: batch.doc_id, rev: event?.rev ?? rev, results, changes: event?.changes ?? [] }
  }

  /** 待采纳修订中的块不能再改（先由用户采纳或拒绝）。 */
  private guardPending(batch: EditBatch, before: PMNode): void {
    const index = indexById(before)
    batch.ops.forEach((op, i) => {
      for (const id of [...targetIds(op), ...('anchor_id' in op ? [op.anchor_id] : [])]) {
        const node = index.get(id)?.node
        if (node?.attrs.suggest) {
          throw new OpError('pending_suggestion', `块 ${id} 在待采纳的修订里`, {
            op_index: i, hint: '等用户采纳或拒绝这条修订后再改；需要时在回复里说明。',
          })
        }
      }
    })
  }

  /** 冲突守卫：目标块在 base_rev 之后被用户改过 → 拒绝，附当前内容。 */
  private guardConflicts(batch: EditBatch, before: PMNode): void {
    const index = indexById(before)
    batch.ops.forEach((op, i) => {
      for (const id of targetIds(op)) {
        const userRev = this.docs.store.lastChangeBy(batch.doc_id, id, 'user')
        if (userRev > batch.base_rev) {
          const node = index.get(id)?.node
          throw new OpError('conflict_user_edited', `块 ${id} 在 rev ${userRev} 被用户修改过（你的 base_rev 是 ${batch.base_rev}）`, {
            op_index: i,
            hint: '以 current 为准重新决定改法，并用新的 rev 作为 base_rev 再提交；用户的修改优先。',
            current: { rev: this.docs.rev(batch.doc_id), markdown: node ? serializeBlock(node, { ids: true }, '') : null },
          })
        }
      }
    })
  }

  /** 引用守卫：写入内容不得出现 DOI / PMID / 手写参考文献；[@c:id] 必须已登记。 */
  private guardCitations(batch: EditBatch): void {
    const registered = new Set(this.docs.store.listCitations(batch.doc_id).map(c => c.id))
    batch.ops.forEach((op, i) => {
      for (const text of opTexts(op)) {
        const withoutCites = text.replace(/\[@c:[a-z0-9]+\]/g, '')
        const doi = DOI.exec(withoutCites)?.[0]
        if (manualCitation(withoutCites)) {
          throw new OpError('citation_not_registered', doi ? `正文里不能直接写 DOI（${doi}）` : '正文里不能手写参考文献条目或 PMID', {
            op_index: i,
            hint: doi
              ? `先调用 insert_citation（doi="${doi}"）登记，再在正文里写它返回的 [@c:<cite_id>]。`
              : '用 pubmed_search 找到文献 → insert_citation 登记 → 正文写 [@c:<cite_id>]。参考文献表由平台自动生成，不要手写。',
          })
        }
        for (const m of text.matchAll(/\[@c:([a-z0-9]+)\]/g)) {
          if (!registered.has(m[1]!)) {
            throw new OpError('citation_unknown', `引用 [@c:${m[1]}] 未在本文档登记`, {
              op_index: i, hint: '只能使用本文档 insert_citation / list_citations 返回的 cite_id。',
            })
          }
        }
      }
    })
  }

  /** 锚点守卫：本批操作会让 open 评论失去锚点，且未在 ack_comments 中确认 → 拒绝。 */
  private guardAnchors(batch: EditBatch, before: PMNode, after: PMNode): void {
    const open = this.docs.store.listComments(batch.doc_id, 'open')
    if (open.length === 0) return
    const ack = new Set(batch.ack_comments ?? [])
    const marksBefore = threadMarks(before)
    const marksAfter = threadMarks(after)
    const lost = open.filter(c => !ack.has(c.id) && locate(before, c, marksBefore).located && !locate(after, c, marksAfter).located)
    if (lost.length > 0) {
      throw new OpError('anchor_has_open_comments', `这些修改会移除 ${lost.length} 条 open 评论的锚点`, {
        hint: '缩小修改范围保留被评论的文字（优先用 replace_text），或确认后把这些线程 id 放进 ack_comments 再提交，并在线程里说明。',
        current: lost.map(c => ({
          comment_id: c.id,
          node_id: c.node_id,
          anchored_text: c.snippet,
          request: c.replies.filter(r => r.role === 'user').at(-1)?.text ?? '',
        })),
      })
    }
  }
}

