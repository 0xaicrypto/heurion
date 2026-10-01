import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Projection } from './docs/office.ts'

export type DocKind = 'docx' | 'pptx'
export type VersionSource = 'upload' | 'user' | 'ai' | 'restore'

export interface DocRow {
  id: string
  title: string
  kind: DocKind
  session_id: string | null
  head_seq: number
  created_at: string
  updated_at: string
}

export interface VersionRow {
  doc_id: string
  seq: number
  sha256: string
  source: VersionSource
  note: string
  created_at: string
  /** 版本元数据（JSON）：如 id 存活率。 */
  meta: VersionMeta | null
}

export interface VersionMeta {
  /** 与上一版投影对比的 id 存活率；null = 首版（无对照）。 */
  id_survival?: number | null
  /** 用户保存（编辑面）提取的节点变更（S5 合并输入）。 */
  user_ops?: { added: string[]; removed: string[]; modified: string[] }
}

export interface ProjectionRow {
  doc_id: string
  seq: number
  projection: Projection
  created_at: string
}

export interface MessageRow {
  id: number
  doc_id: string
  role: 'user' | 'assistant'
  text: string
  created_at: string
}

export interface CitationRow {
  id: string
  doc_id: string
  doi: string
  pmid: string | null
  formatted: string
  created_at: string
}

/** 评论锚点（DESIGN.md §4.4）：id 定位 + 文字片段冗余（跨编辑校验与漂移候选）。 */
export interface CommentAnchor {
  para_id?: string
  shape_id?: string
  slide_id?: string
  text_snippet: string
  section_index?: number
}

export interface CommentReplyRow {
  id: string
  comment_id: string
  role: 'user' | 'ai'
  text: string
  created_at: string
}

export interface CommentRow {
  id: string
  doc_id: string
  kind: DocKind
  anchor: CommentAnchor
  status: 'open' | 'resolved'
  resolved_by: 'user' | 'ai' | null
  /** 漂移：当前版本投影里锚不到（目标消失或片段对不上）。 */
  drifted: boolean
  created_at: string
  replies: CommentReplyRow[]
  /** 最近一次 @heurion 自动触发时的最新用户回复 id（null = 从未触发）。 */
  last_auto_reply_id: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('docx','pptx')),
  session_id TEXT,
  head_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  meta TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, seq)
);
CREATE TABLE IF NOT EXISTS projections (
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  projection TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, seq)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS citations (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  doi TEXT NOT NULL,
  pmid TEXT,
  formatted TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (doc_id, doi)
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('docx','pptx')),
  anchor TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_by TEXT CHECK (resolved_by IN ('user','ai')),
  drifted INTEGER NOT NULL DEFAULT 0,
  file_comment_id TEXT,
  /** 最近一次自动触发（@heurion）时的最新用户回复 id —— 防重复触发。 */
  last_auto_reply_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS comment_replies (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','ai')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`

/** 旧库轻量迁移：缺列就补（SQLite 无 IF NOT EXISTS 的 ADD COLUMN）。 */
function migrate(db: DatabaseSync): void {
  const versionCols = (db.prepare('PRAGMA table_info(versions)').all() as Array<{ name: string }>).map(c => c.name)
  if (!versionCols.includes('meta')) db.exec('ALTER TABLE versions ADD COLUMN meta TEXT')
  const commentCols = (db.prepare('PRAGMA table_info(comments)').all() as Array<{ name: string }>).map(c => c.name)
  if (commentCols.length > 0 && !commentCols.includes('file_comment_id')) {
    db.exec('ALTER TABLE comments ADD COLUMN file_comment_id TEXT')
  }
  if (commentCols.length > 0 && !commentCols.includes('last_auto_reply_id')) {
    db.exec('ALTER TABLE comments ADD COLUMN last_auto_reply_id TEXT')
  }
}

const now = () => new Date().toISOString()

interface VersionDbRow extends Omit<VersionRow, 'meta'> { meta: string | null }

function parseVersion(row: VersionDbRow): VersionRow {
  let meta: VersionMeta | null = null
  if (row.meta) {
    try { meta = JSON.parse(row.meta) as VersionMeta } catch { /* 损坏的 meta 按空处理 */ }
  }
  return { ...row, meta }
}

export class Store {
  readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
    migrate(this.db)
  }

  createDoc(id: string, title: string, kind: DocKind): DocRow {
    const t = now()
    this.db.prepare('INSERT INTO docs (id, title, kind, head_seq, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
      .run(id, title, kind, t, t)
    return this.getDoc(id)!
  }

  getDoc(id: string): DocRow | undefined {
    return this.db.prepare('SELECT * FROM docs WHERE id = ?').get(id) as DocRow | undefined
  }

  listDocs(): DocRow[] {
    return this.db.prepare('SELECT * FROM docs ORDER BY updated_at DESC').all() as unknown as DocRow[]
  }

  setSession(docId: string, sessionId: string): void {
    this.db.prepare('UPDATE docs SET session_id = ?, updated_at = ? WHERE id = ?').run(sessionId, now(), docId)
  }

  addVersion(docId: string, sha256: string, source: VersionSource, note = '', meta?: VersionMeta): VersionRow {
    const doc = this.getDoc(docId)
    if (!doc) throw new Error(`doc ${docId} not found`)
    const seq = doc.head_seq + 1
    const t = now()
    this.db.prepare('INSERT INTO versions (doc_id, seq, sha256, source, note, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(docId, seq, sha256, source, note, meta ? JSON.stringify(meta) : null, t)
    this.db.prepare('UPDATE docs SET head_seq = ?, updated_at = ? WHERE id = ?').run(seq, t, docId)
    return this.getVersion(docId, seq)!
  }

  listVersions(docId: string): VersionRow[] {
    return (this.db.prepare('SELECT * FROM versions WHERE doc_id = ? ORDER BY seq DESC').all(docId) as unknown as VersionDbRow[])
      .map(parseVersion)
  }

  getVersion(docId: string, seq: number): VersionRow | undefined {
    const row = this.db.prepare('SELECT * FROM versions WHERE doc_id = ? AND seq = ?').get(docId, seq) as VersionDbRow | undefined
    return row ? parseVersion(row) : undefined
  }

  /** 版本投影（S1：落版即导入）。 */
  setProjection(docId: string, seq: number, projection: Projection): void {
    this.db.prepare('INSERT OR REPLACE INTO projections (doc_id, seq, projection, created_at) VALUES (?, ?, ?, ?)')
      .run(docId, seq, JSON.stringify(projection), now())
  }

  getProjection(docId: string, seq: number): ProjectionRow | undefined {
    const row = this.db.prepare('SELECT * FROM projections WHERE doc_id = ? AND seq = ?').get(docId, seq) as
      { doc_id: string; seq: number; projection: string; created_at: string } | undefined
    if (!row) return undefined
    try { return { ...row, projection: JSON.parse(row.projection) as Projection } } catch { return undefined }
  }

  // —— 评论（S2） ——

  addComment(docId: string, anchor: CommentAnchor, fileCommentId?: string): CommentRow {
    const doc = this.getDoc(docId)
    if (!doc) throw new Error(`doc ${docId} not found`)
    const t = now()
    const id = randomUUID()
    this.db.prepare('INSERT INTO comments (id, doc_id, kind, anchor, status, drifted, file_comment_id, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
      .run(id, docId, doc.kind, JSON.stringify(anchor), 'open', fileCommentId ?? null, t)
    return this.getComment(docId, id)!
  }

  /** 编辑器（Collabora）文件内评论的去重查找。 */
  getCommentByFileId(docId: string, fileCommentId: string): CommentRow | undefined {
    const row = this.db.prepare('SELECT id FROM comments WHERE doc_id = ? AND file_comment_id = ?').get(docId, fileCommentId) as { id: string } | undefined
    return row ? this.getComment(docId, row.id) : undefined
  }

  /** 双重过滤（id + docId）——防跨文档枚举。 */
  getComment(docId: string, commentId: string): CommentRow | undefined {
    const row = this.db.prepare('SELECT * FROM comments WHERE id = ? AND doc_id = ?').get(commentId, docId) as
      { id: string; doc_id: string; kind: DocKind; anchor: string; status: 'open' | 'resolved'; resolved_by: 'user' | 'ai' | null; drifted: number; file_comment_id: string | null; last_auto_reply_id: string | null; created_at: string } | undefined
    if (!row) return undefined
    const replies = (this.db.prepare('SELECT * FROM comment_replies WHERE comment_id = ? ORDER BY created_at, rowid').all(commentId) as unknown as CommentReplyRow[])
    let anchor: CommentAnchor = { text_snippet: '' }
    try { anchor = JSON.parse(row.anchor) as CommentAnchor } catch { /* 损坏锚点按空处理 */ }
    return {
      id: row.id, doc_id: row.doc_id, kind: row.kind, anchor, status: row.status,
      resolved_by: row.resolved_by, drifted: row.drifted === 1, created_at: row.created_at, replies,
      last_auto_reply_id: row.last_auto_reply_id,
    }
  }

  listComments(docId: string, status?: 'open' | 'resolved'): CommentRow[] {
    const rows = status
      ? this.db.prepare('SELECT id FROM comments WHERE doc_id = ? AND status = ? ORDER BY created_at, rowid').all(docId, status) as Array<{ id: string }>
      : this.db.prepare('SELECT id FROM comments WHERE doc_id = ? ORDER BY created_at, rowid').all(docId) as Array<{ id: string }>
    return rows.map(r => this.getComment(docId, r.id)!).filter(c => c !== undefined)
  }

  addReply(docId: string, commentId: string, role: 'user' | 'ai', text: string): CommentReplyRow {
    const comment = this.getComment(docId, commentId)
    if (!comment) throw new Error(`comment ${commentId} not found in doc ${docId}`)
    const reply: CommentReplyRow = { id: randomUUID(), comment_id: commentId, role, text, created_at: now() }
    this.db.prepare('INSERT INTO comment_replies (id, comment_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(reply.id, commentId, role, text, reply.created_at)
    return reply
  }

  /** 关闭线程；by 记录发起方（用户手动 or AI resolve）。重复关闭幂等返回 false。 */
  resolveComment(docId: string, commentId: string, by: 'user' | 'ai'): boolean {
    const comment = this.getComment(docId, commentId)
    if (!comment || comment.status === 'resolved') return false
    this.db.prepare("UPDATE comments SET status = 'resolved', resolved_by = ?, drifted = 0 WHERE id = ?").run(by, commentId)
    return true
  }

  reopenComment(docId: string, commentId: string): boolean {
    const comment = this.getComment(docId, commentId)
    if (!comment || comment.status === 'open') return false
    this.db.prepare("UPDATE comments SET status = 'open', resolved_by = NULL WHERE id = ?").run(commentId)
    return true
  }

  setCommentDrift(commentId: string, drifted: boolean): void {
    this.db.prepare('UPDATE comments SET drifted = ? WHERE id = ?').run(drifted ? 1 : 0, commentId)
  }

  /** 记录 @heurion 自动触发水位（最新用户回复 id），防同一回复重复触发。 */
  markAutoTriggered(commentId: string, replyId: string): void {
    this.db.prepare('UPDATE comments SET last_auto_reply_id = ? WHERE id = ?').run(replyId, commentId)
  }

  /** 删除线程（回复随 FK 级联）。 */
  deleteComment(docId: string, commentId: string): boolean {
    const comment = this.getComment(docId, commentId)
    if (!comment) return false
    this.db.prepare('DELETE FROM comments WHERE id = ?').run(commentId)
    return true
  }

  addMessage(docId: string, role: MessageRow['role'], text: string): void {
    this.db.prepare('INSERT INTO messages (doc_id, role, text, created_at) VALUES (?, ?, ?, ?)').run(docId, role, text, now())
  }

  listMessages(docId: string): MessageRow[] {
    return this.db.prepare('SELECT * FROM messages WHERE doc_id = ? ORDER BY id').all(docId) as unknown as MessageRow[]
  }

  /** 同一文档同一 DOI 只登记一次，重复登记返回已有记录。 */
  upsertCitation(row: Omit<CitationRow, 'created_at'>): CitationRow {
    this.db.prepare(
      'INSERT INTO citations (id, doc_id, doi, pmid, formatted, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (doc_id, doi) DO NOTHING',
    ).run(row.id, row.doc_id, row.doi, row.pmid, row.formatted, now())
    return this.db.prepare('SELECT * FROM citations WHERE doc_id = ? AND doi = ?').get(row.doc_id, row.doi) as unknown as CitationRow
  }

  listCitations(docId: string): CitationRow[] {
    return this.db.prepare('SELECT * FROM citations WHERE doc_id = ? ORDER BY created_at').all(docId) as unknown as CitationRow[]
  }
}
