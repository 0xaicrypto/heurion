import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * 平台存储（PLATFORM.md §3 存储层）：
 * - docs.state：当前 Yjs 状态（每次提交后整体写回；P0 文档规模下足够）
 * - op_log / node_changes：只增的操作日志与节点级变更索引（冲突守卫用）
 * - versions：用户可见的版本快照（Yjs 状态）
 * - node_src：导入时保留的原始 OOXML（修补式导出用）
 */

export type DocKind = 'doc' | 'deck'
export type Actor = 'ai' | 'user' | 'system'
export type VersionSource = 'create' | 'import' | 'turn' | 'user' | 'restore'

export interface DocRow {
  id: string
  owner: string
  title: string
  kind: DocKind
  rev: number
  created_at: string
  updated_at: string
}

export interface VersionRow {
  doc_id: string
  seq: number
  rev: number
  source: VersionSource
  turn_id: string | null
  note: string
  created_at: string
}

export interface CitationRow {
  id: string
  doc_id: string
  doi: string
  pmid: string | null
  formatted: string
  url: string | null
  created_at: string
}

export interface CommentRow {
  id: string
  doc_id: string
  node_id: string
  snippet: string
  status: 'open' | 'resolved'
  resolved_by: Actor | null
  created_at: string
  replies: ReplyRow[]
}

export interface ReplyRow {
  id: string
  comment_id: string
  role: 'user' | 'ai'
  text: string
  turn_id: string | null
  created_at: string
}

export interface AssetRow {
  id: string
  owner: string
  mime: string
  name: string
  size: number
  created_at: string
}

export interface TurnRow {
  id: string
  user_id: string
  doc_id: string | null
  message: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  started_at: string
  ended_at: string | null
}

export interface MessageRow {
  id: string
  doc_id: string
  role: 'user' | 'assistant'
  text: string
  turn_id: string | null
  created_at: string
}

const now = () => new Date().toISOString()

export class Store {
  readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL,
        rev INTEGER NOT NULL DEFAULT 0, state BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS op_log (
        doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, rev INTEGER NOT NULL,
        actor TEXT NOT NULL, turn_id TEXT, ops TEXT NOT NULL, affected TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (doc_id, rev)
      );
      CREATE TABLE IF NOT EXISTS node_changes (
        doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, rev INTEGER NOT NULL,
        node_id TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS node_changes_idx ON node_changes (doc_id, node_id, actor, rev);
      CREATE TABLE IF NOT EXISTS versions (
        doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, seq INTEGER NOT NULL, rev INTEGER NOT NULL,
        source TEXT NOT NULL, turn_id TEXT, note TEXT NOT NULL, state BLOB NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (doc_id, seq)
      );
      CREATE TABLE IF NOT EXISTS node_src (
        doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, node_id TEXT NOT NULL, xml TEXT NOT NULL,
        PRIMARY KEY (doc_id, node_id)
      );
      CREATE TABLE IF NOT EXISTS doc_packages (
        doc_id TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE, kind TEXT NOT NULL, bytes BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, mime TEXT NOT NULL, name TEXT NOT NULL,
        size INTEGER NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS citations (
        id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, doi TEXT NOT NULL,
        pmid TEXT, formatted TEXT NOT NULL, url TEXT, created_at TEXT NOT NULL, UNIQUE (doc_id, doi)
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, node_id TEXT NOT NULL,
        snippet TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolved_by TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comment_replies (
        id TEXT PRIMARY KEY, comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        role TEXT NOT NULL, text TEXT NOT NULL, turn_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, doc_id TEXT, message TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, role TEXT NOT NULL,
        text TEXT NOT NULL, turn_id TEXT, created_at TEXT NOT NULL
      );
    `)
  }

  // —— 文档 ——

  createDoc(input: { id?: string; owner: string; title: string; kind: DocKind; state: Uint8Array }): DocRow {
    const id = input.id ?? randomUUID()
    const t = now()
    this.db.prepare('INSERT INTO docs (id, owner, title, kind, rev, state, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
      .run(id, input.owner, input.title, input.kind, input.state, t, t)
    return this.getDoc(id)!
  }

  getDoc(id: string): DocRow | undefined {
    return this.db.prepare('SELECT id, owner, title, kind, rev, created_at, updated_at FROM docs WHERE id = ?').get(id) as DocRow | undefined
  }

  listDocs(owner: string): DocRow[] {
    return this.db.prepare('SELECT id, owner, title, kind, rev, created_at, updated_at FROM docs WHERE owner = ? ORDER BY updated_at DESC')
      .all(owner) as unknown as DocRow[]
  }

  getState(id: string): Uint8Array | null {
    const row = this.db.prepare('SELECT state FROM docs WHERE id = ?').get(id) as { state: Uint8Array | null } | undefined
    return row?.state ?? null
  }

  renameDoc(id: string, title: string): void {
    this.db.prepare('UPDATE docs SET title = ?, updated_at = ? WHERE id = ?').run(title, now(), id)
  }

  deleteDoc(id: string): void {
    this.db.prepare('DELETE FROM docs WHERE id = ?').run(id)
  }

  /**
   * 一次提交：rev+1、写状态、追加 op log 与节点变更索引——同一事务。
   * 返回新 rev。
   */
  commit(input: {
    docId: string
    actor: Actor
    turnId: string | null
    state: Uint8Array
    ops: unknown
    changes: Array<{ node_id: string; kind: 'added' | 'modified' | 'removed' }>
  }): number {
    this.db.exec('BEGIN')
    try {
      const doc = this.getDoc(input.docId)
      if (!doc) throw new Error(`doc ${input.docId} not found`)
      const rev = doc.rev + 1
      const t = now()
      this.db.prepare('UPDATE docs SET rev = ?, state = ?, updated_at = ? WHERE id = ?').run(rev, input.state, t, input.docId)
      this.db.prepare('INSERT INTO op_log (doc_id, rev, actor, turn_id, ops, affected, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(input.docId, rev, input.actor, input.turnId, JSON.stringify(input.ops), JSON.stringify(input.changes), t)
      const ins = this.db.prepare('INSERT INTO node_changes (doc_id, rev, node_id, actor, kind) VALUES (?, ?, ?, ?, ?)')
      for (const c of input.changes) ins.run(input.docId, rev, c.node_id, input.actor, c.kind)
      this.db.exec('COMMIT')
      return rev
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** 节点在 sinceRev 之后是否被某类写者改过（冲突守卫）。 */
  lastChangeBy(docId: string, nodeId: string, actor: Actor): number {
    const row = this.db.prepare('SELECT MAX(rev) AS rev FROM node_changes WHERE doc_id = ? AND node_id = ? AND actor = ?')
      .get(docId, nodeId, actor) as { rev: number | null }
    return row.rev ?? 0
  }

  /** 某回合涉及的文档。 */
  docsTouchedByTurn(turnId: string): string[] {
    return (this.db.prepare('SELECT DISTINCT doc_id FROM op_log WHERE turn_id = ?').all(turnId) as Array<{ doc_id: string }>).map(r => r.doc_id)
  }

  opLog(docId: string, sinceRev = 0): Array<{ rev: number; actor: Actor; turn_id: string | null; affected: unknown; created_at: string }> {
    return (this.db.prepare('SELECT rev, actor, turn_id, affected, created_at FROM op_log WHERE doc_id = ? AND rev > ? ORDER BY rev')
      .all(docId, sinceRev) as Array<{ rev: number; actor: Actor; turn_id: string | null; affected: string; created_at: string }>)
      .map(r => ({ ...r, affected: JSON.parse(r.affected) }))
  }

  // —— 版本 ——

  addVersion(input: { docId: string; rev: number; source: VersionSource; turnId?: string | null; note: string; state: Uint8Array }): VersionRow {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM versions WHERE doc_id = ?').get(input.docId) as { seq: number }
    const seq = row.seq + 1
    this.db.prepare('INSERT INTO versions (doc_id, seq, rev, source, turn_id, note, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(input.docId, seq, input.rev, input.source, input.turnId ?? null, input.note, input.state, now())
    return this.getVersion(input.docId, seq)!
  }

  getVersion(docId: string, seq: number): VersionRow | undefined {
    return this.db.prepare('SELECT doc_id, seq, rev, source, turn_id, note, created_at FROM versions WHERE doc_id = ? AND seq = ?')
      .get(docId, seq) as VersionRow | undefined
  }

  getVersionState(docId: string, seq: number): Uint8Array | null {
    const row = this.db.prepare('SELECT state FROM versions WHERE doc_id = ? AND seq = ?').get(docId, seq) as { state: Uint8Array } | undefined
    return row?.state ?? null
  }

  listVersions(docId: string): VersionRow[] {
    return this.db.prepare('SELECT doc_id, seq, rev, source, turn_id, note, created_at FROM versions WHERE doc_id = ? ORDER BY seq DESC')
      .all(docId) as unknown as VersionRow[]
  }

  latestVersion(docId: string): VersionRow | undefined {
    return this.db.prepare('SELECT doc_id, seq, rev, source, turn_id, note, created_at FROM versions WHERE doc_id = ? ORDER BY seq DESC LIMIT 1')
      .get(docId) as VersionRow | undefined
  }

  // —— 原始 XML ——

  putNodeSrc(docId: string, entries: Array<{ node_id: string; xml: string }>): void {
    const ins = this.db.prepare('INSERT OR REPLACE INTO node_src (doc_id, node_id, xml) VALUES (?, ?, ?)')
    for (const e of entries) ins.run(docId, e.node_id, e.xml)
  }

  getNodeSrc(docId: string, nodeId: string): string | null {
    const row = this.db.prepare('SELECT xml FROM node_src WHERE doc_id = ? AND node_id = ?').get(docId, nodeId) as { xml: string } | undefined
    return row?.xml ?? null
  }

  // —— 原始文件包（修补式导出的底座：样式、编号、关系、媒体） ——

  putPackage(docId: string, kind: 'docx' | 'pptx', bytes: Uint8Array): void {
    this.db.prepare('INSERT OR REPLACE INTO doc_packages (doc_id, kind, bytes) VALUES (?, ?, ?)').run(docId, kind, bytes)
  }

  getPackage(docId: string): Uint8Array | null {
    const row = this.db.prepare('SELECT bytes FROM doc_packages WHERE doc_id = ?').get(docId) as { bytes: Uint8Array } | undefined
    return row?.bytes ?? null
  }

  // —— 资产 ——

  putAsset(input: { owner: string; mime: string; name: string; bytes: Uint8Array }): AssetRow {
    const id = 'a' + randomUUID().replace(/-/g, '').slice(0, 15)
    this.db.prepare('INSERT INTO assets (id, owner, mime, name, size, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.owner, input.mime, input.name, input.bytes.byteLength, input.bytes, now())
    return this.getAsset(id)!
  }

  getAsset(id: string): AssetRow | undefined {
    return this.db.prepare('SELECT id, owner, mime, name, size, created_at FROM assets WHERE id = ?').get(id) as AssetRow | undefined
  }

  getAssetBytes(id: string): Uint8Array | null {
    const row = this.db.prepare('SELECT bytes FROM assets WHERE id = ?').get(id) as { bytes: Uint8Array } | undefined
    return row?.bytes ?? null
  }

  // —— 引用 ——

  upsertCitation(input: { doc_id: string; doi: string; pmid: string | null; formatted: string; url: string | null }): CitationRow {
    const existing = this.db.prepare('SELECT * FROM citations WHERE doc_id = ? AND doi = ?').get(input.doc_id, input.doi) as CitationRow | undefined
    if (existing) return existing
    const id = 'c' + randomUUID().replace(/-/g, '').slice(0, 7)
    this.db.prepare('INSERT INTO citations (id, doc_id, doi, pmid, formatted, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.doc_id, input.doi, input.pmid, input.formatted, input.url, now())
    return this.db.prepare('SELECT * FROM citations WHERE id = ?').get(id) as unknown as CitationRow
  }

  listCitations(docId: string): CitationRow[] {
    return this.db.prepare('SELECT * FROM citations WHERE doc_id = ? ORDER BY created_at').all(docId) as unknown as CitationRow[]
  }

  // —— 评论 ——

  addComment(input: { doc_id: string; node_id: string; snippet: string; id?: string }): CommentRow {
    const id = input.id ?? 't' + randomUUID().replace(/-/g, '').slice(0, 7)
    this.db.prepare('INSERT INTO comments (id, doc_id, node_id, snippet, status, created_at) VALUES (?, ?, ?, ?, \'open\', ?)')
      .run(id, input.doc_id, input.node_id, input.snippet, now())
    return this.getComment(input.doc_id, id)!
  }

  getComment(docId: string, id: string): CommentRow | undefined {
    const row = this.db.prepare('SELECT * FROM comments WHERE doc_id = ? AND id = ?').get(docId, id) as Omit<CommentRow, 'replies'> | undefined
    if (!row) return undefined
    return { ...row, replies: this.replies(id) }
  }

  listComments(docId: string, status?: 'open' | 'resolved'): CommentRow[] {
    const rows = (status
      ? this.db.prepare('SELECT * FROM comments WHERE doc_id = ? AND status = ? ORDER BY created_at').all(docId, status)
      : this.db.prepare('SELECT * FROM comments WHERE doc_id = ? ORDER BY created_at').all(docId)) as unknown as Array<Omit<CommentRow, 'replies'>>
    return rows.map(r => ({ ...r, replies: this.replies(r.id) }))
  }

  private replies(commentId: string): ReplyRow[] {
    return this.db.prepare('SELECT * FROM comment_replies WHERE comment_id = ? ORDER BY created_at, rowid').all(commentId) as unknown as ReplyRow[]
  }

  addReply(commentId: string, role: 'user' | 'ai', text: string, turnId: string | null = null): ReplyRow {
    const id = randomUUID()
    this.db.prepare('INSERT INTO comment_replies (id, comment_id, role, text, turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, commentId, role, text, turnId, now())
    return this.db.prepare('SELECT * FROM comment_replies WHERE id = ?').get(id) as unknown as ReplyRow
  }

  setCommentStatus(docId: string, id: string, status: 'open' | 'resolved', by: Actor | null): boolean {
    return this.db.prepare('UPDATE comments SET status = ?, resolved_by = ? WHERE doc_id = ? AND id = ?')
      .run(status, by, docId, id).changes > 0
  }

  // —— 回合与对话 ——

  createTurn(input: { user_id: string; doc_id: string | null; message: string }): TurnRow {
    const id = 'r' + randomUUID().replace(/-/g, '').slice(0, 11)
    this.db.prepare('INSERT INTO turns (id, user_id, doc_id, message, status, started_at) VALUES (?, ?, ?, ?, \'running\', ?)')
      .run(id, input.user_id, input.doc_id, input.message, now())
    return this.db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as unknown as TurnRow
  }

  endTurn(id: string, status: TurnRow['status']): void {
    this.db.prepare('UPDATE turns SET status = ?, ended_at = ? WHERE id = ?').run(status, now(), id)
  }

  addMessage(docId: string, role: 'user' | 'assistant', text: string, turnId: string | null): MessageRow {
    const id = randomUUID()
    this.db.prepare('INSERT INTO messages (id, doc_id, role, text, turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, docId, role, text, turnId, now())
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as MessageRow
  }

  listMessages(docId: string): MessageRow[] {
    return this.db.prepare('SELECT * FROM messages WHERE doc_id = ? ORDER BY created_at, rowid').all(docId) as unknown as MessageRow[]
  }
}
