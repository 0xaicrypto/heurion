import { existsSync, readFileSync } from 'node:fs'
import { ID_SURVIVAL_WARN, buildProjection, ensureDocxParaIds } from './office.ts'
import { mergeAiOpsOntoHead } from './merge.ts'
import type { Store } from '../db.ts'
import { mapNotification, type UiEvent } from '../harness/events.ts'
import type { HarnessPool } from '../harness/pool.ts'
import { auditCitations, extractOfficeText } from '../literature/audit.ts'
import { canonicalFileName, type DocFiles } from './workspace.ts'

export class BusyError extends Error {}

/** 评论触发回合的服务端 prompt（手动「请 AI 处理」与 @heurion 自动触发共用）。 */
export function buildCommentPrompt(cid: string): string {
  return (
    `请处理评论 ${cid}。步骤：\n` +
    `1. 用 list_comments（comment_id="${cid}"）读取该线程的锚点与用户要求；\n` +
    `2. 按锚点（漂移时用候选文本）在工作区文件里定位目标内容，完成用户要求的修改；\n` +
    `3. 若修改涉及检索文献，按引用规范走 pubmed_search / insert_citation；\n` +
    `4. 完成后用 reply_comment 在线程内说明改了什么、改在哪；确实无需改动才允许 resolve_comment。\n` +
    `只处理这一条评论，不要动它以外的内容。`
  )
}

/**
 * 一个 AI 回合：清工作区脚本 → 写入 head → dsh 执行 → 引用/锚点审计 → 合并落版。
 * 引用校验不过时让模型自修一次；仍不过则丢弃本轮文件改动（工作区回到 head）。
 */
export class TurnService {
  /** 回合结束回调（@heurion 自动触发队列接力用）。 */
  onTurnEnd: (docId: string) => void = () => {}

  constructor(
    private readonly store: Store,
    private readonly files: DocFiles,
    private readonly pool: HarnessPool,
  ) {}

  async run(docId: string, message: string, emit: (e: UiEvent) => void, opts: { commentId?: string } = {}): Promise<void> {
    try {
      await this._run(docId, message, emit, opts)
    } finally {
      this.onTurnEnd(docId)
    }
  }

  private async _run(docId: string, message: string, emit: (e: UiEvent) => void, opts: { commentId?: string } = {}): Promise<void> {
    const commentId = opts.commentId
    const startedAt = new Date().toISOString()
    const doc = this.store.getDoc(docId)
    if (!doc) throw new Error(`doc ${docId} not found`)
    if (this.pool.isBusy(docId)) throw new BusyError('AI 正在编辑这份文档')

    // 防止模型重跑上一轮的辅助脚本把文件整篇重新生成（#1）。
    this.files.cleanWorkspaceScripts(docId)
    this.store.addMessage(docId, 'user', message)
    const openBefore = new Set(this.store.listComments(docId, 'open').map(c => c.id))
    const baseSeq = doc.head_seq
    const baseSha = this.files.materializeHead(docId)

    // 边改边看：回合进行中周期性把工作区有效状态落成中间版本（meta.intermediate）
    // → LastModifiedTime 变化 → 编辑器自动刷新，用户实时看到 AI 的编辑进度。
    const progress = setInterval(() => {
      try {
        const v = this.files.snapshotIntermediate(docId)
        if (v) emit({ type: 'version', seq: v.seq })
      } catch { /* 单次失败不干预回合 */ }
    }, 8_000)
    progress.unref()

    try {
      const fileName = canonicalFileName(doc.kind)
      const prompt = baseSha === null
        ? `（当前还没有 ${fileName}，需要时在工作目录新建。）\n\n${message}`
        : `（要编辑的文件：${fileName}）\n\n${message}`

      // SDK 无法跨进程恢复会话：新进程里的首轮要把最近对话带进提示，保持上下文连续。
      const isNewSession = this.pool.liveSession(docId) === null
      const history = isNewSession ? this.recentHistory(docId) : ''
      const turn = async (text: string) => {
        const result = await this.pool.run(docId, text, (n, sessionId) => {
          for (const e of mapNotification(n, sessionId)) emit(e)
        })
        this.store.setSession(docId, result.sessionId)
        return result
      }

      const first = await turn(history + prompt)
      let finalText = first.finalResponse

      let audit = this.audit(docId)
      emit({ type: 'citation_audit', ...audit }) // 通过/不通过都推（前端展示"校验通过"）
      if (!audit.ok) {
        emit({ type: 'citation_audit', ...audit })
        const fix = await turn(
          `引用校验未通过：文中出现未登记的 DOI ${audit.unregisteredDois.join(', ')}。` +
          '请对每条引用调用 insert_citation 登记（查不到的删除），并按 list_citations 重建参考文献列表，然后保存。',
        )
        finalText = fix.finalResponse
        audit = this.audit(docId)
        emit({ type: 'citation_audit', ...audit })
      }

      if (finalText) this.store.addMessage(docId, 'assistant', finalText)
      if (!audit.ok) {
        this.files.materializeHead(docId)
        emit({ type: 'error', message: '引用校验仍未通过，本轮文件改动已丢弃。' })
        return
      }

      // 用户优先（DESIGN.md §4.3）：回合开始后用户手动保存推进了 head。
      // 注意：进行中快照（meta.intermediate）也会推进 head_seq —— 那是 AI 自己的落版，
      // 不算用户推进；只有区间里出现 user/upload 版本才走合并/丢弃路径。
      const headNow = this.store.getDoc(docId)!.head_seq
      if (headNow !== baseSeq && this.userAdvancedBetween(docId, baseSeq, headNow)) {
        const merged = doc.kind === 'docx' ? this.mergeOntoUserHead(docId, baseSeq, headNow) : null
        if (!merged) {
          this.files.materializeHead(docId)
          emit({ type: 'error', message: `回合期间文档被手动更新（当前 v${headNow}），本轮 AI 改动已丢弃，请基于新版本重试。` })
          return
        }
        // 合并后重跑引用审计（AI 带来的引用文本已并入）
        const mergedAudit = auditCitations(extractOfficeText(merged.bytes), this.store.listCitations(docId).map(c => c.doi))
        if (!mergedAudit.ok) {
          emit({ type: 'citation_audit', ...mergedAudit })
          this.files.materializeHead(docId)
          emit({ type: 'error', message: '合并结果引用校验未通过，本轮 AI 改动已丢弃。' })
          return
        }
        const version = this.files.landMerged(docId, merged.bytes, message.slice(0, 80))
        emit({ type: 'merge_result', applied: merged.applied.map(a => `${a.kind}:${a.id}`), overridden: merged.overridden })
        emit({ type: 'version', seq: version.seq })
        this.ensureThreadReply(docId, commentId, startedAt, merged.overridden.length > 0
          ? `并行合并：你手动更新的 ${merged.overridden.length} 处内容保留了你的版本，AI 对同一处的修改已丢弃；其余改动已合并为 v${version.seq}。`
          : `AI 已把修改合并进你手动保存的版本（v${version.seq}）：异处的改动双方都保留。`)
        this.emitCommentEvents(docId, openBefore, emit)
        return
      }

      const version = this.files.snapshotAfterTurn(docId, baseSha, message.slice(0, 80))
      if (version) {
        emit({ type: 'version', seq: version.seq })
        // id 存活率告警（#1）：低于阈值 = 疑似整文重写，锚点大概率整体失效。
        const rate = version.meta?.id_survival
        if (typeof rate === 'number' && rate < ID_SURVIVAL_WARN) emit({ type: 'id_survival_warning', rate })
        this.ensureThreadReply(docId, commentId, startedAt,
          `AI 已按评论完成修改（v${version.seq}）。编辑器会自动刷新到新版本。`)
      } else {
        // 工作区与最后中间版一致：把它转正（去 intermediate 标记 + 换真实 note）。
        const finalized = this.files.finalizeIntermediate(docId, message.slice(0, 80))
        if (finalized) emit({ type: 'version', seq: finalized.seq })
      }
      this.emitCommentEvents(docId, openBefore, emit)
    } finally {
      clearInterval(progress)
    }
  }

  /** (base, head] 区间内是否存在用户主动落版。 */
  private userAdvancedBetween(docId: string, baseSeq: number, headNow: number): boolean {
    for (let s = baseSeq + 1; s <= headNow; s++) {
      const v = this.store.getVersion(docId, s)
      if (v && (v.source === 'user' || v.source === 'upload')) return true
    }
    return false
  }

  private ensureThreadReply(
    docId: string,
    commentId: string | undefined,
    startedAt: string,
    fallbackText: string,
  ): void {
    if (!commentId) return
    const c = this.store.getComment(docId, commentId)
    if (!c || c.status !== 'open') return
    const last = c.replies[c.replies.length - 1]
    const hasNewAiReply = last?.role === 'ai' && last.created_at >= startedAt // 本回合内新增的 AI 回复
    if (!hasNewAiReply) this.store.addReply(docId, commentId, 'ai', fallbackText)
  }

  /** 回合结束时评论状态事件（S2/S3）。 */
  private emitCommentEvents(docId: string, openBefore: Set<string>, emit: (e: UiEvent) => void): void {
    const openAfter = this.store.listComments(docId, 'open')
    const updated = [...openBefore].filter(id => !openAfter.some(c => c.id === id))
    const drifted = openAfter.filter(c => c.drifted).map(c => c.id)
    if (updated.length > 0 || drifted.length > 0) emit({ type: 'comment_updates', updated, drifted })
  }

  /**
   * S5 三方合并：AI 工作区文件（基于 baseSeq 基线）× 用户当前 head。
   * 任何一步拿不到就返回 null（调用方走丢弃路径）。
   */
  private mergeOntoUserHead(docId: string, baseSeq: number, headNow: number) {
    const baseProj = this.store.getProjection(docId, baseSeq)?.projection
    const headProj = this.store.getProjection(docId, headNow)?.projection
    if (!baseProj || !headProj) return null
    const aiBytes = ensureDocxParaIds(readFileSync(this.files.workspaceFile(docId, 'docx'))).bytes
    const aiProj = buildProjection('docx', aiBytes)
    if ((aiProj.nodes ?? []).length === 0) return null
    const headBytes = this.files.readVersion(docId, headNow)
    return mergeAiOpsOntoHead({ baseProj, aiBytes, aiProj, headBytes, headProj })
  }

  /** 最近 6 条对话，作为新会话首轮的背景（不含本轮消息）。 */
  private recentHistory(docId: string): string {
    const msgs = this.store.listMessages(docId).slice(0, -1).slice(-6)
    if (msgs.length === 0) return ''
    const lines = msgs.map(m => `${m.role === 'user' ? '用户' : '助手'}：${m.text.slice(0, 500)}`)
    return `（此前的对话，供参考）\n${lines.join('\n')}\n\n`
  }

  private audit(docId: string) {
    const doc = this.store.getDoc(docId)!
    const path = this.files.workspaceFile(docId, doc.kind)
    if (!existsSync(path)) return { ok: true, unregisteredDois: [] }
    let text: string
    try {
      text = extractOfficeText(readFileSync(path))
    } catch {
      // 损坏的包交给版本层兜底：这里不拦，结构检查由 dsh office 技能负责。
      return { ok: true, unregisteredDois: [] }
    }
    return auditCitations(text, this.store.listCitations(docId).map(c => c.doi))
  }
}
