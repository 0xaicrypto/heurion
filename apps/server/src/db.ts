import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Projection } from './docs/office.ts'

export type DocKind = 'docx' | 'pptx'
export type VersionSource = 'upload' | 'ai' | 'restore'

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
`

/** 旧库轻量迁移：缺列就补（SQLite 无 IF NOT EXISTS 的 ADD COLUMN）。 */
function migrate(db: DatabaseSync): void {
  const versionCols = (db.prepare('PRAGMA table_info(versions)').all() as Array<{ name: string }>).map(c => c.name)
  if (!versionCols.includes('meta')) db.exec('ALTER TABLE versions ADD COLUMN meta TEXT')
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
