import { EventEmitter } from 'node:events'
import type { Node as PMNode } from 'prosemirror-model'
import * as Y from 'yjs'
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import type { Actor, DocKind, DocRow, Store, VersionRow, VersionSource } from '../store/db.ts'
import { assignIds, collectIds } from './ids.ts'
import { schema } from './schema.ts'
import { deckSchema } from './deck-schema.ts'
import { revertByNodes } from '../ops/revert.ts'

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
const LEAF_BLOCKS = new Set(['paragraph', 'heading', 'figure', 'opaque', 'table', 'shape'])

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

/** 文档类型对应的 schema。 */
export const schemaFor = (kind: DocKind) => kind === 'deck' ? deckSchema : schema

export function stateToDoc(state: Uint8Array, kind: DocKind = 'doc'): PMNode {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, state)
  return yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(BODY), schemaFor(kind))
}

function docToState(doc: PMNode): Uint8Array {
  const ydoc = new Y.Doc()
  ydoc.transact(() => writeFragment(ydoc, doc))
  return Y.encodeStateAsUpdate(ydoc)
}

/**
 * 把模型写入 Y.Doc：updateYFragment 做最小差异，然后读回逐个顶层块核对。y-prosemirror 1.3.7 在
 * 行内原子节点（引用）之后的文字只改格式时不会更新格式属性（实测：粗体 → 评论标记无效），
 * 核对不一致的顶层块整块重写——内容一定对，代价只是该块在协同端的光标位置。
 */
export function writeFragment(ydoc: Y.Doc, next: PMNode): void {
  const fragment = ydoc.getXmlFragment(BODY)
  updateYFragment(ydoc, fragment, next, { mapping: new Map(), isOMark: new Map() } as never)
  const got = yXmlFragmentToProseMirrorRootNode(fragment, next.type.schema)
  if (got.eq(next)) return
  if (got.childCount !== next.childCount) {
    fragment.delete(0, fragment.length)
    fragment.insert(0, freshElements(next, 0, next.childCount))
    return
  }
  for (let i = 0; i < next.childCount; i++) {
    if (got.child(i).eq(next.child(i))) continue
    fragment.delete(i, 1)
    fragment.insert(i, freshElements(next, i, i + 1))
  }
}

/** 顶层块 [from, to) 的全新 Yjs 元素（在临时 Y.Doc 里生成后克隆，可插入任何文档）。 */
function freshElements(doc: PMNode, from: number, to: number): Y.XmlElement[] {
  const tmp = new Y.Doc()
  const nodes: PMNode[] = []
  for (let i = from; i < to; i++) nodes.push(doc.child(i))
  const part = doc.type.create(doc.attrs, nodes)
  tmp.transact(() => updateYFragment(tmp, tmp.getXmlFragment(BODY), part, { mapping: new Map(), isOMark: new Map() } as never))
  return tmp.getXmlFragment(BODY).toArray().map(el => (el as Y.XmlElement).clone())
}

/** 服务端提交的 Yjs origin（区别于浏览器经协同网关送来的更新）。 */
export interface ServerOrigin { server: true; actor: Actor; turnId: string | null }

const isServerOrigin = (origin: unknown): origin is ServerOrigin =>
  typeof origin === 'object' && origin !== null && (origin as ServerOrigin).server === true

/** 用户编辑合批落库的间隔。 */
const USER_FLUSH_MS = 400
/** 每份文档保留可撤销的最近 AI 回合数。 */
const TURN_UNDO_KEEP = 20

interface Loaded {
  kind: DocKind
  ydoc: Y.Doc
  rev: number
  cache: PMNode | null
  /** 上一次落库时的内容（用户编辑合批的 diff 基准）。 */
  committed: PMNode
  timer: NodeJS.Timeout | null
  /** 回合 id → 该回合的 Yjs 撤销器（只跟踪该回合的提交）。 */
  turnUndo: Map<string, { origin: ServerOrigin; um: Y.UndoManager }>
}

/**
 * 文档运行时：每个文档一个 Y.Doc（内存常驻）。
 * - 服务端写入（AI / 导入 / 回滚 / 评论锚点）经 commit 以单个 Yjs 事务提交，origin = ServerOrigin；
 * - 浏览器的编辑经协同网关直接写进同一个 Y.Doc，按 USER_FLUSH_MS 合批成一次用户提交
 *   （rev+1、op log、节点变更索引），并修复编辑器拆段带来的重复 id；
 * - 每个 AI 回合有自己的 Y.UndoManager：撤销本轮只撤掉该回合的改动，用户在此期间的编辑保留（CRDT 语义）。
 */
export class Documents extends EventEmitter<{ commit: [CommitEvent] }> {
  private readonly loaded = new Map<string, Loaded>()

  constructor(readonly store: Store) {
    super()
  }

  /** 新建文档：content 缺省为一个空段落；同时落 v1。 */
  create(input: { owner: string; title: string; kind?: DocKind; content?: PMNode; source?: VersionSource; id?: string }): DocRow {
    const kind = input.kind ?? 'doc'
    const empty = kind === 'deck'
      ? deckSchema.node('doc', null, [deckSchema.node('slide')])
      : schema.node('doc', null, [schema.node('paragraph')])
    const content = assignIds(input.content ?? empty, new Set())
    const row = this.store.createDoc({ id: input.id, owner: input.owner, title: input.title, kind, state: docToState(content) })
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
      const committed = yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(BODY), schemaFor(row.kind))
      const loaded: Loaded = { kind: row.kind, ydoc, rev: row.rev, cache: committed, committed, timer: null, turnUndo: new Map() }
      ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
        loaded.cache = null
        if (isServerOrigin(origin)) return
        // 浏览器编辑（或回合撤销）：合批落库
        if (loaded.timer) clearTimeout(loaded.timer)
        loaded.timer = setTimeout(() => { this.flush(docId) }, USER_FLUSH_MS)
        loaded.timer.unref?.()
      })
      l = loaded
      this.loaded.set(docId, l)
    }
    return l
  }

  /** 当前文档（PM 节点，只读）。 */
  get(docId: string): PMNode {
    const l = this.load(docId)
    l.cache ??= yXmlFragmentToProseMirrorRootNode(l.ydoc.getXmlFragment(BODY), schemaFor(l.kind))
    return l.cache
  }

  rev(docId: string): number {
    return this.load(docId).rev
  }

  ydoc(docId: string): Y.Doc {
    return this.load(docId).ydoc
  }

  /**
   * 把尚未落库的浏览器编辑落成一次用户提交。修复重复 / 缺失的块 id（编辑器拆段、粘贴会复制 id），
   * 修复本身以服务端事务写回（广播给所有客户端）。返回提交事件，没有变化时返回 null。
   */
  flush(docId: string, ops: unknown = [{ op: 'collab' }]): CommitEvent | null {
    const l = this.loaded.get(docId)
    if (!l) return null
    if (l.timer) { clearTimeout(l.timer); l.timer = null }
    if (!this.store.getDoc(docId)) return null
    let after = this.get(docId)
    if (after.eq(l.committed)) return null
    const fixed = assignIds(after, collectIds(after))
    if (!fixed.eq(after)) {
      l.ydoc.transact(() => {
        writeFragment(l.ydoc, fixed)
      }, { server: true, actor: 'system', turnId: null } satisfies ServerOrigin)
      l.cache = null
      after = this.get(docId)
    }
    return this.record(docId, l, after, { actor: 'user', turnId: null, ops })
  }

  private record(docId: string, l: Loaded, after: PMNode, meta: { actor: Actor; turnId: string | null; ops: unknown }): CommitEvent {
    const changes = diffNodes(l.committed, after)
    const rev = this.store.commit({
      docId, actor: meta.actor, turnId: meta.turnId, state: Y.encodeStateAsUpdate(l.ydoc), ops: meta.ops, changes,
    })
    l.rev = rev
    l.committed = after
    const event: CommitEvent = { docId, rev, actor: meta.actor, turnId: meta.turnId, changes }
    this.emit('commit', event)
    return event
  }

  /**
   * 服务端写入：把 next 写成新的当前状态（y-prosemirror 做最小差异更新，未改动的节点在 Yjs 里
   * 保持原样）。先落掉尚未落库的浏览器编辑，冲突守卫才能看到用户最新的改动。没有实际变化时返回 null。
   */
  commit(docId: string, next: PMNode, meta: { actor: Actor; turnId: string | null; ops: unknown }): CommitEvent | null {
    const l = this.load(docId)
    this.flush(docId)
    const before = this.get(docId)
    if (before.eq(next)) return null
    // AI 回合第一次写这份文档：记下回合开始前的状态（服务重启后按节点撤销的依据）
    if (meta.actor === 'ai' && meta.turnId) this.store.putTurnBase(meta.turnId, docId, Y.encodeStateAsUpdate(l.ydoc))
    const origin = this.originFor(docId, l, meta)
    l.ydoc.transact(() => writeFragment(l.ydoc, next), origin)
    l.cache = null
    return this.record(docId, l, this.get(docId), meta)
  }

  /** AI 回合的提交共用一个 origin，并挂上只跟踪它的撤销器。 */
  private originFor(docId: string, l: Loaded, meta: { actor: Actor; turnId: string | null }): ServerOrigin {
    if (meta.actor !== 'ai' || !meta.turnId) return { server: true, actor: meta.actor, turnId: meta.turnId }
    let entry = l.turnUndo.get(meta.turnId)
    if (!entry) {
      const origin: ServerOrigin = { server: true, actor: 'ai', turnId: meta.turnId }
      const um = new Y.UndoManager(l.ydoc.getXmlFragment(BODY), { trackedOrigins: new Set([origin]), captureTimeout: Number.MAX_SAFE_INTEGER })
      entry = { origin, um }
      l.turnUndo.set(meta.turnId, entry)
      while (l.turnUndo.size > TURN_UNDO_KEEP) {
        const oldest = l.turnUndo.keys().next().value!
        l.turnUndo.get(oldest)!.um.destroy()
        l.turnUndo.delete(oldest)
      }
    }
    return entry.origin
  }

  /** 该回合能否撤销：内存里有撤销器，或有持久化的回合起点且未撤销过。 */
  canRevertTurn(docId: string, turnId: string): boolean {
    if (this.load(docId).turnUndo.get(turnId)?.um.canUndo()) return true
    const base = this.store.getTurnBase(turnId, docId)
    return Boolean(base && !base.reverted)
  }

  /**
   * 撤销某个 AI 回合对本文档的全部改动，落成一次用户提交。
   * 有撤销器（服务未重启）：Yjs 撤销只移除该回合插入 / 恢复该回合删除的内容，用户期间的编辑保留；
   * 否则按节点撤销（revertByNodes）：用户之后改过的块跳过，返回跳过的块 id。
   */
  revertTurn(docId: string, turnId: string): { event: CommitEvent | null; skipped: string[] } | null {
    const l = this.load(docId)
    const entry = l.turnUndo.get(turnId)
    if (entry?.um.canUndo()) {
      this.flush(docId)
      while (entry.um.canUndo()) entry.um.undo()
      entry.um.destroy()
      l.turnUndo.delete(turnId)
      this.store.markTurnReverted(turnId, docId)
      return { event: this.flush(docId, [{ op: 'revert_turn', turn_id: turnId }]), skipped: [] }
    }
    const base = this.store.getTurnBase(turnId, docId)
    if (!base || base.reverted) return null
    this.flush(docId)
    const turn = this.store.turnChanges(turnId, docId)
    const { doc, skipped } = revertByNodes(this.get(docId), stateToDoc(base.state, l.kind), turn.changes, this.store.userTouchedSince(docId, turn.minRev))
    const event = this.commit(docId, doc, { actor: 'user', turnId: null, ops: [{ op: 'revert_turn', turn_id: turnId, by: 'nodes' }] })
    this.store.markTurnReverted(turnId, docId)
    return { event, skipped }
  }

  /** 打版本快照（回合结束、用户保存、导入、回滚）。与上一版本 rev 相同则不重复打。 */
  snapshot(docId: string, source: VersionSource, note: string, turnId: string | null = null): VersionRow | null {
    const l = this.load(docId)
    this.flush(docId)
    const latest = this.store.latestVersion(docId)
    if (latest && latest.rev === l.rev) return null
    return this.store.addVersion({ docId, rev: l.rev, source, turnId, note, state: Y.encodeStateAsUpdate(l.ydoc) })
  }

  versionDoc(docId: string, seq: number): PMNode | null {
    const state = this.store.getVersionState(docId, seq)
    return state ? stateToDoc(state, this.load(docId).kind) : null
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

  /** 落掉全部未落库的编辑（关停前调用）。 */
  flushAll(): void {
    for (const id of this.loaded.keys()) this.flush(id)
  }

  unload(docId: string): void {
    const l = this.loaded.get(docId)
    if (l?.timer) clearTimeout(l.timer)
    for (const { um } of l?.turnUndo.values() ?? []) um.destroy()
    l?.ydoc.destroy()
    this.loaded.delete(docId)
  }
}
