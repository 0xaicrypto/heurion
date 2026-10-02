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

export interface UserRow {
  id: string
  username: string
  display_name: string
  password_hash: string
  role: 'user' | 'admin'
  status: 'active' | 'disabled'
  /** 令牌版本：停用、改密码、强制下线时加一，旧令牌立即失效。 */
  token_version: number
  created_at: string
  last_login_at: string | null
  /** 从 1.0 导入时的原用户 id。 */
  imported_from: string | null
}

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

export type ClaimVerdict = 'supported' | 'unsupported' | 'unclear' | 'missing_citation'

export interface ClaimCheckRow {
  doc_id: string
  claim_id: string
  node_id: string
  sentence: string
  verdict: ClaimVerdict
  reason: string
  comment_id: string | null
  rev: number
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
  status: 'running' | 'done' | 'error' | 'cancelled' | 'interrupted' | 'timeout'
  started_at: string
  ended_at: string | null
  /** 未正常完成时的原因（报错文字 / 超时 / 取消说明）。 */
  error: string | null
}

export interface QueuedJobRow {
  id: string
  user_id: string
  doc_id: string
  message: string
  /** TurnOptions 的 JSON。 */
  opts: string
  enqueued_at: string
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
const userKey = (username: string) => username.normalize('NFKC').toLowerCase()

export class Store {
  readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active',
        token_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_login_at TEXT, imported_from TEXT
      );
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
      CREATE TABLE IF NOT EXISTS citation_abstracts (
        doi TEXT PRIMARY KEY, pmid TEXT, abstract TEXT, fetched_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claim_checks (
        doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, claim_id TEXT NOT NULL, node_id TEXT NOT NULL,
        sentence TEXT NOT NULL, verdict TEXT NOT NULL, reason TEXT NOT NULL, comment_id TEXT, rev INTEGER NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY (doc_id, claim_id)
      );
      CREATE TABLE IF NOT EXISTS turn_bases (
        turn_id TEXT NOT NULL, doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        state BLOB NOT NULL, reverted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (turn_id, doc_id)
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
        started_at TEXT NOT NULL, ended_at TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS turn_queue (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        message TEXT NOT NULL, opts TEXT NOT NULL, enqueued_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, role TEXT NOT NULL,
        text TEXT NOT NULL, turn_id TEXT, created_at TEXT NOT NULL
      );
    `)
    // 旧库补列：回合失败 / 超时 / 取消的原因
    const turnCols = (this.db.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>).map(c => c.name)
    if (!turnCols.includes('error')) this.db.exec('ALTER TABLE turns ADD COLUMN error TEXT')
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

  // —— 用户 ——

  /** 用户名比较不区分大小写（username_key）。第一个用户自动成为管理员。 */
  createUser(input: { username: string; display_name: string; password_hash: string; role?: UserRow['role']; status?: UserRow['status']; imported_from?: string | null }): UserRow {
    const id = 'u' + randomUUID().replace(/-/g, '').slice(0, 15)
    const role = input.role ?? (this.countUsers() === 0 ? 'admin' : 'user')
    this.db.prepare(`INSERT INTO users (id, username, username_key, display_name, password_hash, role, status, created_at, imported_from)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.username, userKey(input.username), input.display_name, input.password_hash, role, input.status ?? 'active', now(), input.imported_from ?? null)
    return this.getUser(id)!
  }

  getUser(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined
  }

  getUserByName(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username_key = ?').get(userKey(username)) as unknown as UserRow | undefined
  }

  countUsers(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n)
  }

  listUsers(): Array<UserRow & { doc_count: number }> {
    return this.db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM docs d WHERE d.owner = u.id) AS doc_count FROM users u ORDER BY u.created_at`)
      .all() as unknown as Array<UserRow & { doc_count: number }>
  }

  updateUser(id: string, patch: Partial<Pick<UserRow, 'display_name' | 'password_hash' | 'role' | 'status'>> & { bumpTokenVersion?: boolean; touchLogin?: boolean }): UserRow | undefined {
    const sets: string[] = []
    const args: Array<string | number> = []
    for (const k of ['display_name', 'password_hash', 'role', 'status'] as const) {
      if (patch[k] !== undefined) { sets.push(`${k} = ?`); args.push(patch[k]!) }
    }
    if (patch.bumpTokenVersion) sets.push('token_version = token_version + 1')
    if (patch.touchLogin) { sets.push('last_login_at = ?'); args.push(now()) }
    if (sets.length > 0) this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
    return this.getUser(id)
  }

  /** 开发期的数据（所有者是开发用户）转给一个正式账户。 */
  transferOwnership(from: string, to: string): { docs: number; assets: number } {
    const docs = Number(this.db.prepare('UPDATE docs SET owner = ? WHERE owner = ?').run(to, from).changes)
    const assets = Number(this.db.prepare('UPDATE assets SET owner = ? WHERE owner = ?').run(to, from).changes)
    return { docs, assets }
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

  // —— 论断核对 ——

  getAbstract(doi: string): { pmid: string | null; abstract: string | null } | null {
    return (this.db.prepare('SELECT pmid, abstract FROM citation_abstracts WHERE doi = ?').get(doi) as { pmid: string | null; abstract: string | null } | undefined) ?? null
  }

  putAbstract(doi: string, pmid: string | null, abstract: string | null): void {
    this.db.prepare('INSERT OR REPLACE INTO citation_abstracts (doi, pmid, abstract, fetched_at) VALUES (?, ?, ?, ?)').run(doi, pmid, abstract, now())
  }

  getClaimCheck(docId: string, claimId: string): ClaimCheckRow | undefined {
    return this.db.prepare('SELECT * FROM claim_checks WHERE doc_id = ? AND claim_id = ?').get(docId, claimId) as ClaimCheckRow | undefined
  }

  putClaimCheck(row: Omit<ClaimCheckRow, 'created_at'>): void {
    this.db.prepare('INSERT OR REPLACE INTO claim_checks (doc_id, claim_id, node_id, sentence, verdict, reason, comment_id, rev, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.doc_id, row.claim_id, row.node_id, row.sentence, row.verdict, row.reason, row.comment_id, row.rev, now())
  }

  listClaimChecks(docId: string): ClaimCheckRow[] {
    return this.db.prepare('SELECT * FROM claim_checks WHERE doc_id = ? ORDER BY created_at DESC').all(docId) as unknown as ClaimCheckRow[]
  }

  // —— AI 回合开始前的状态（撤销本轮的持久化依据） ——

  putTurnBase(turnId: string, docId: string, state: Uint8Array): void {
    this.db.prepare('INSERT OR IGNORE INTO turn_bases (turn_id, doc_id, state) VALUES (?, ?, ?)').run(turnId, docId, state)
  }

  getTurnBase(turnId: string, docId: string): { state: Uint8Array; reverted: boolean } | null {
    const row = this.db.prepare('SELECT state, reverted FROM turn_bases WHERE turn_id = ? AND doc_id = ?').get(turnId, docId) as { state: Uint8Array; reverted: number } | undefined
    return row ? { state: row.state, reverted: row.reverted === 1 } : null
  }

  markTurnReverted(turnId: string, docId: string): void {
    this.db.prepare('UPDATE turn_bases SET reverted = 1 WHERE turn_id = ? AND doc_id = ?').run(turnId, docId)
  }

  /** 某回合在某文档上的节点变更（按 rev 顺序）与该回合的 rev 范围。 */
  turnChanges(turnId: string, docId: string): { changes: Array<{ node_id: string; kind: 'added' | 'modified' | 'removed' }>; minRev: number; maxRev: number } {
    const rows = this.db.prepare('SELECT rev, affected FROM op_log WHERE doc_id = ? AND turn_id = ? ORDER BY rev').all(docId, turnId) as Array<{ rev: number; affected: string }>
    return {
      changes: rows.flatMap(r => JSON.parse(r.affected) as Array<{ node_id: string; kind: 'added' | 'modified' | 'removed' }>),
      minRev: rows[0]?.rev ?? 0,
      maxRev: rows.at(-1)?.rev ?? 0,
    }
  }

  /** sinceRev 之后被用户改过的节点。 */
  userTouchedSince(docId: string, sinceRev: number): Set<string> {
    const rows = this.db.prepare('SELECT DISTINCT node_id FROM node_changes WHERE doc_id = ? AND actor = \'user\' AND rev > ?').all(docId, sinceRev) as Array<{ node_id: string }>
    return new Set(rows.map(r => r.node_id))
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

  endTurn(id: string, status: TurnRow['status'], error: string | null = null): void {
    this.db.prepare('UPDATE turns SET status = ?, ended_at = ?, error = ? WHERE id = ?').run(status, now(), error, id)
  }

  /** 文档里没有正常完成的回合（对话记录里标出失败原因）。 */
  failedTurns(docId: string): Array<Pick<TurnRow, 'id' | 'status' | 'error' | 'ended_at'>> {
    return this.db.prepare("SELECT id, status, error, ended_at FROM turns WHERE doc_id = ? AND status NOT IN ('done', 'running') ORDER BY started_at")
      .all(docId) as unknown as Array<Pick<TurnRow, 'id' | 'status' | 'error' | 'ended_at'>>
  }

  // —— 回合队列（持久化：服务重启后排队中的任务继续执行） ——

  enqueueJob(job: QueuedJobRow): void {
    this.db.prepare('INSERT INTO turn_queue (id, user_id, doc_id, message, opts, enqueued_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(job.id, job.user_id, job.doc_id, job.message, job.opts, job.enqueued_at)
  }

  dequeueJob(id: string): void {
    this.db.prepare('DELETE FROM turn_queue WHERE id = ?').run(id)
  }

  listQueuedJobs(): QueuedJobRow[] {
    return this.db.prepare('SELECT * FROM turn_queue ORDER BY enqueued_at, rowid').all() as unknown as QueuedJobRow[]
  }

  /** 服务启动时：上次进程里没跑完的回合标为 interrupted。 */
  interruptRunningTurns(): number {
    return Number(this.db.prepare("UPDATE turns SET status = 'interrupted', ended_at = ?, error = '服务重启，回合被中断' WHERE status = 'running'").run(now()).changes)
  }

  /** 评论锚点所在块与引用文字（打锚点 / 重新锚定后同步）。 */
  setCommentAnchor(id: string, nodeId: string, snippet: string): void {
    this.db.prepare('UPDATE comments SET node_id = ?, snippet = ? WHERE id = ?').run(nodeId, snippet, id)
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
