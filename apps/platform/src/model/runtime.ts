import { EventEmitter } from 'node:events'
import type { Node as PMNode } from 'prosemirror-model'
import * as Y from 'yjs'
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import type { Actor, DocKind, DocRow, Store, VersionRow, VersionSource } from '../store/db.ts'
import { assignIds, collectIds } from './ids.ts'
import { schema } from './schema.ts'

/** Yjs 里存放正文的 fragment 名。 */
const BODY = 'body'

export interface NodeChange { node_id: string; kind: 'added' | 'modified' | 'removed' }

export interface CommitEvent {
  docId: string
  rev: number
  actor: Actor
  turnId: string | null
  changes: NodeChange[]
}

/** 变更 diff 时计入「修改」的节点：叶子级块（容器类只记增删）。 */
const LEAF_BLOCKS = new Set(['paragraph', 'heading', 'figure', 'opaque', 'table'])

function addressableMap(doc: PMNode): Map<string, PMNode> {
  const map = new Map<string, PMNode>()
  doc.descendants(n => {
    if (n.attrs.id) map.set(n.attrs.id as string, n)
    // 表格内部按整表比较
    return n.type.name !== 'table'
  })
  return map
}

/** 两版文档的节点级差异（按 id）。 */
export function diffNodes(before: PMNode, after: PMNode): NodeChange[] {
  const a = addressableMap(before)
  const b = addressableMap(after)
  const out: NodeChange[] = []
  for (const [id, node] of b) {
    const prev = a.get(id)
    if (!prev) out.push({ node_id: id, kind: 'added' })
    else if (LEAF_BLOCKS.has(node.type.name) && !prev.eq(node)) out.push({ node_id: id, kind: 'modified' })
  }
  for (const id of a.keys()) if (!b.has(id)) out.push({ node_id: id, kind: 'removed' })
  return out
}

export function stateToDoc(state: Uint8Array): PMNode {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, state)
  return yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(BODY), schema)
}

function docToState(doc: PMNode): Uint8Array {
  const ydoc = new Y.Doc()
  ydoc.transact(() => updateYFragment(ydoc, ydoc.getXmlFragment(BODY), doc, { mapping: new Map(), isOMark: new Map() } as never))
  return Y.encodeStateAsUpdate(ydoc)
}

interface Loaded { ydoc: Y.Doc; rev: number; cache: PMNode | null }

/**
 * 文档运行时：每个文档一个 Y.Doc（内存常驻），所有写入经 commit 以单个 Yjs 事务提交，
 * origin = { actor, turnId }。协同网关（P1）挂在同一个 Y.Doc 上。
 */
export class Documents extends EventEmitter<{ commit: [CommitEvent] }> {
  private readonly loaded = new Map<string, Loaded>()

  constructor(readonly store: Store) {
    super()
  }

  /** 新建文档：content 缺省为一个空段落；同时落 v1。 */
  create(input: { owner: string; title: string; kind?: DocKind; content?: PMNode; source?: VersionSource; id?: string }): DocRow {
    const content = assignIds(input.content ?? schema.node('doc', null, [schema.node('paragraph')]), new Set())
    const row = this.store.createDoc({ id: input.id, owner: input.owner, title: input.title, kind: input.kind ?? 'doc', state: docToState(content) })
    this.store.addVersion({ docId: row.id, rev: 0, source: input.source ?? 'create', note: input.source === 'import' ? '导入' : '新建', state: this.store.getState(row.id)! })
    return row
  }

  private load(docId: string): Loaded {
    let l = this.loaded.get(docId)
    if (!l) {
      const row = this.store.getDoc(docId)
      const state = this.store.getState(docId)
      if (!row || !state) throw new Error(`doc ${docId} not found`)
      const ydoc = new Y.Doc()
      Y.applyUpdate(ydoc, state)
      l = { ydoc, rev: row.rev, cache: null }
      this.loaded.set(docId, l)
    }
    return l
  }

  /** 当前文档（PM 节点，只读）。 */
  get(docId: string): PMNode {
    const l = this.load(docId)
    l.cache ??= yXmlFragmentToProseMirrorRootNode(l.ydoc.getXmlFragment(BODY), schema)
    return l.cache
  }

  rev(docId: string): number {
    return this.load(docId).rev
  }

  ydoc(docId: string): Y.Doc {
    return this.load(docId).ydoc
  }

  /**
   * 把 next 写成新的当前状态（y-prosemirror 做最小差异更新，未改动的节点在 Yjs 里保持原样）。
   * 没有实际变化时不提交，返回 null。
   */
  commit(docId: string, next: PMNode, meta: { actor: Actor; turnId: string | null; ops: unknown }): CommitEvent | null {
    const l = this.load(docId)
    const before = this.get(docId)
    if (before.eq(next)) return null
    const changes = diffNodes(before, next)
    l.ydoc.transact(() => {
      updateYFragment(l.ydoc, l.ydoc.getXmlFragment(BODY), next, { mapping: new Map(), isOMark: new Map() } as never)
    }, { actor: meta.actor, turnId: meta.turnId })
    l.cache = null
    const rev = this.store.commit({
      docId, actor: meta.actor, turnId: meta.turnId, state: Y.encodeStateAsUpdate(l.ydoc), ops: meta.ops, changes,
    })
    l.rev = rev
    const event: CommitEvent = { docId, rev, actor: meta.actor, turnId: meta.turnId, changes }
    this.emit('commit', event)
    return event
  }

  /** 打版本快照（回合结束、用户保存、导入、回滚）。与上一版本 rev 相同则不重复打。 */
  snapshot(docId: string, source: VersionSource, note: string, turnId: string | null = null): VersionRow | null {
    const l = this.load(docId)
    const latest = this.store.latestVersion(docId)
    if (latest && latest.rev === l.rev) return null
    return this.store.addVersion({ docId, rev: l.rev, source, turnId, note, state: Y.encodeStateAsUpdate(l.ydoc) })
  }

  versionDoc(docId: string, seq: number): PMNode | null {
    const state = this.store.getVersionState(docId, seq)
    return state ? stateToDoc(state) : null
  }

  /** 回滚：把旧版本内容作为一次用户提交写回（历史只增），并打版本。 */
  restore(docId: string, seq: number): VersionRow | null {
    const old = this.versionDoc(docId, seq)
    if (!old) throw new Error(`version ${seq} not found`)
    this.commit(docId, old, { actor: 'user', turnId: null, ops: [{ op: 'restore', seq }] })
    return this.snapshot(docId, 'restore', `回滚到 v${seq}`)
  }

  /** 文档内已占用 id（分配新 id 用）。 */
  takenIds(docId: string): Set<string> {
    return collectIds(this.get(docId))
  }

  unload(docId: string): void {
    this.loaded.get(docId)?.ydoc.destroy()
    this.loaded.delete(docId)
  }
}
