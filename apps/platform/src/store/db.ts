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
  /** 已验证的邮箱（找回密码用）；未绑定为 null。 */
  email: string | null
}

export interface DocRow {
  id: string
  owner: string
  title: string
  kind: DocKind
  rev: number
  created_at: string
  updated_at: string
  /** 所在项目（文件夹）；null 为未分组。 */
  project_id: string | null
  /** 进了回收站的时间；null 为正常文档。 */
  deleted_at: string | null
}

export type KbStatus = 'pending' | 'extracting' | 'ocr' | 'embedding' | 'ready' | 'failed'

/** 参考资料库里的一份资料（R2）。 */
export interface KbFileRow {
  id: string
  owner: string
  project_id: string | null
  name: string
  mime: string
  size: number
  sha256: string
  status: KbStatus
  /** 失败原因 / 提示（扫描件没有文字层等）。 */
  note: string | null
  pages: number
  chunks: number
  /** 已向量化的块数（嵌入服务不可用时为 0，仍可关键词检索）。 */
  embedded: number
  doi: string | null
  pmid: string | null
  created_at: string
}

export type MemoryKind = 'preference' | 'fact' | 'style' | 'term'
export type MemoryStatus = 'proposed' | 'active' | 'rejected' | 'archived'

/** R3 记忆：一条用户偏好 / 事实 / 写法 / 术语。 */
export interface MemoryRow {
  id: string
  owner: string
  scope: 'global' | 'project'
  project_id: string | null
  kind: MemoryKind
  content: string
  /** AI 提议时给的理由。 */
  reason: string | null
  source: 'turn' | 'comment' | 'manual' | 'import'
  source_doc_id: string | null
  source_turn_id: string | null
  status: MemoryStatus
  /** 用户在对话里明确要求记住（直接生效）。 */
  explicit: number
  created_at: string
  updated_at: string
}

export interface MemoryEventRow { id: string; memory_id: string; owner: string; action: string; actor: 'user' | 'ai' | 'system'; before: string | null; after: string | null; at: string }

export interface KbChunkHit {
  chunk_id: string
  file_id: string
  file_name: string
  page: number
  text: string
  doi: string | null
  pmid: string | null
  score: number
}

export interface ProjectRow {
  id: string
  owner: string
  name: string
  created_at: string
}

export interface SearchHit {
  doc_id: string
  title: string
  kind: DocKind
  project_id: string | null
  updated_at: string
  /** 命中处前后的文字（命中词用 [ ] 括起）。 */
  snippet: string
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
  /** 回合选项（TurnOptions 的 JSON：修订模式、回答的评论），重试时沿用。 */
  opts: string
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
        token_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_login_at TEXT, imported_from TEXT, email TEXT
      );
      CREATE TABLE IF NOT EXISTS verification_codes (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, ip TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS verification_codes_target ON verification_codes (target, purpose, created_at);
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL,
        rev INTEGER NOT NULL DEFAULT 0, state BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(doc_id UNINDEXED, owner UNINDEXED, title, body, tokenize = 'trigram');
      CREATE TABLE IF NOT EXISTS kb_files (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, project_id TEXT, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, status TEXT NOT NULL, note TEXT, pages INTEGER NOT NULL DEFAULT 0, chunks INTEGER NOT NULL DEFAULT 0,
        embedded INTEGER NOT NULL DEFAULT 0, doi TEXT, pmid TEXT, bytes BLOB NOT NULL, created_at TEXT NOT NULL,
        UNIQUE (owner, sha256)
      );
      CREATE TABLE IF NOT EXISTS kb_chunks (
        id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES kb_files(id) ON DELETE CASCADE, owner TEXT NOT NULL,
        seq INTEGER NOT NULL, page INTEGER NOT NULL, text TEXT NOT NULL, embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS kb_chunks_file ON kb_chunks (file_id, seq);
      CREATE INDEX IF NOT EXISTS kb_chunks_owner ON kb_chunks (owner);
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(chunk_id UNINDEXED, owner UNINDEXED, text, tokenize = 'trigram');
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
        started_at TEXT NOT NULL, ended_at TEXT, error TEXT, opts TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS turn_queue (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        message TEXT NOT NULL, opts TEXT NOT NULL, enqueued_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope TEXT NOT NULL, project_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL,
        norm TEXT NOT NULL, reason TEXT, source TEXT NOT NULL, source_doc_id TEXT, source_turn_id TEXT, status TEXT NOT NULL,
        explicit INTEGER NOT NULL DEFAULT 0, embedding BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_owner ON memories (owner, status);
      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, owner TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL,
        before TEXT, after TEXT, at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_events_memory ON memory_events (memory_id, at);
      CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key));
      CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, role TEXT NOT NULL,
        text TEXT NOT NULL, turn_id TEXT, created_at TEXT NOT NULL
      );
    `)
    // 旧库补列：回合失败 / 超时 / 取消的原因
    const turnCols = (this.db.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>).map(c => c.name)
    if (!turnCols.includes('error')) this.db.exec('ALTER TABLE turns ADD COLUMN error TEXT')
    if (!turnCols.includes('opts')) this.db.exec("ALTER TABLE turns ADD COLUMN opts TEXT NOT NULL DEFAULT '{}'")
    const docCols = (this.db.prepare('PRAGMA table_info(docs)').all() as Array<{ name: string }>).map(c => c.name)
    if (!docCols.includes('project_id')) this.db.exec('ALTER TABLE docs ADD COLUMN project_id TEXT')
    if (!docCols.includes('deleted_at')) this.db.exec('ALTER TABLE docs ADD COLUMN deleted_at TEXT')
    const userCols = (this.db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map(c => c.name)
    if (!userCols.includes('email')) this.db.exec('ALTER TABLE users ADD COLUMN email TEXT')
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email) WHERE email IS NOT NULL')
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
    return this.db.prepare('SELECT id, owner, title, kind, rev, created_at, updated_at, project_id, deleted_at FROM docs WHERE id = ?').get(id) as DocRow | undefined
  }

  // —— 用户 ——

  /** 用户名比较不区分大小写（username_key）。第一个用户自动成为管理员。 */
  createUser(input: { username: string; display_name: string; password_hash: string; role?: UserRow['role']; status?: UserRow['status']; imported_from?: string | null; email?: string | null }): UserRow {
    const id = 'u' + randomUUID().replace(/-/g, '').slice(0, 15)
    const role = input.role ?? (this.countUsers() === 0 ? 'admin' : 'user')
    this.db.prepare(`INSERT INTO users (id, username, username_key, display_name, password_hash, role, status, created_at, imported_from, email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.username, userKey(input.username), input.display_name, input.password_hash, role, input.status ?? 'active', now(), input.imported_from ?? null, input.email ?? null)
    return this.getUser(id)!
  }

  getUser(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined
  }

  getUserByName(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username_key = ?').get(userKey(username)) as unknown as UserRow | undefined
  }

  getUserByEmail(email: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as unknown as UserRow | undefined
  }

  setUserEmail(id: string, email: string | null): void {
    this.db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, id)
  }

  // —— 邮箱验证码（只存哈希） ——

  addVerificationCode(row: { id: string; target: string; purpose: string; code_hash: string; ip: string | null; created_at: number; expires_at: number }): void {
    this.db.prepare('INSERT INTO verification_codes (id, target, purpose, code_hash, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.target, row.purpose, row.code_hash, row.ip, row.created_at, row.expires_at)
  }

  latestVerificationCode(target: string, purpose: string): { id: string; code_hash: string; attempts: number; created_at: number; expires_at: number; used_at: number | null } | undefined {
    return this.db.prepare('SELECT * FROM verification_codes WHERE target = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1')
      .get(target, purpose) as unknown as ReturnType<Store['latestVerificationCode']>
  }

  countVerificationCodesByIp(ip: string, since: number): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM verification_codes WHERE ip = ? AND created_at >= ?').get(ip, since) as { n: number }).n)
  }

  markVerificationCode(id: string, patch: { used?: boolean; attempt?: boolean }): void {
    if (patch.used) this.db.prepare('UPDATE verification_codes SET used_at = ? WHERE id = ?').run(Date.now(), id)
    if (patch.attempt) this.db.prepare('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?').run(id)
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

  /** 正常文档（不含回收站）。 */
  listDocs(owner: string): DocRow[] {
    return this.db.prepare('SELECT id, owner, title, kind, rev, created_at, updated_at, project_id, deleted_at FROM docs WHERE owner = ? AND deleted_at IS NULL ORDER BY updated_at DESC')
      .all(owner) as unknown as DocRow[]
  }

  allDocIds(): string[] {
    return (this.db.prepare('SELECT id FROM docs').all() as Array<{ id: string }>).map(r => r.id)
  }

  listTrash(owner: string): DocRow[] {
    return this.db.prepare('SELECT id, owner, title, kind, rev, created_at, updated_at, project_id, deleted_at FROM docs WHERE owner = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC')
      .all(owner) as unknown as DocRow[]
  }

  /** 移进回收站 / 恢复（deleted = false）。 */
  trashDoc(id: string, deleted: boolean): void {
    this.db.prepare('UPDATE docs SET deleted_at = ? WHERE id = ?').run(deleted ? now() : null, id)
  }

  /** 回收站里超过 days 天的文档彻底删除，返回删掉的 id。 */
  purgeTrash(days: number): string[] {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString()
    const rows = this.db.prepare('SELECT id FROM docs WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff) as Array<{ id: string }>
    for (const r of rows) this.deleteDoc(r.id)
    return rows.map(r => r.id)
  }

  setDocProject(id: string, projectId: string | null): void {
    this.db.prepare('UPDATE docs SET project_id = ? WHERE id = ?').run(projectId, id)
  }

  // —— 参考资料库（R2） ——

  /** 新资料；同一用户上传同样的文件（按内容哈希）返回已有的那份。 */
  addKbFile(input: { owner: string; project_id: string | null; name: string; mime: string; bytes: Uint8Array; sha256: string }): { row: KbFileRow; duplicate: boolean } {
    const existing = this.db.prepare('SELECT id, owner, project_id, name, mime, size, sha256, status, note, pages, chunks, embedded, doi, pmid, created_at FROM kb_files WHERE owner = ? AND sha256 = ?').get(input.owner, input.sha256) as unknown as KbFileRow | undefined
    if (existing) return { row: existing, duplicate: true }
    const id = 'f' + randomUUID().replace(/-/g, '').slice(0, 11)
    this.db.prepare(`INSERT INTO kb_files (id, owner, project_id, name, mime, size, sha256, status, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id, input.owner, input.project_id, input.name, input.mime, input.bytes.length, input.sha256, input.bytes, now())
    return { row: this.getKbFile(id)!, duplicate: false }
  }

  getKbFile(id: string): KbFileRow | undefined {
    return this.db.prepare('SELECT id, owner, project_id, name, mime, size, sha256, status, note, pages, chunks, embedded, doi, pmid, created_at FROM kb_files WHERE id = ?').get(id) as unknown as KbFileRow | undefined
  }

  getKbBytes(id: string): Uint8Array | null {
    const r = this.db.prepare('SELECT bytes FROM kb_files WHERE id = ?').get(id) as { bytes: Uint8Array } | undefined
    return r ? new Uint8Array(r.bytes) : null
  }

  listKbFiles(owner: string, projectId?: string | null): KbFileRow[] {
    if (projectId === undefined) return this.db.prepare('SELECT id, owner, project_id, name, mime, size, sha256, status, note, pages, chunks, embedded, doi, pmid, created_at FROM kb_files WHERE owner = ? ORDER BY created_at DESC').all(owner) as unknown as KbFileRow[]
    return this.db.prepare('SELECT id, owner, project_id, name, mime, size, sha256, status, note, pages, chunks, embedded, doi, pmid, created_at FROM kb_files WHERE owner = ? AND project_id IS ? ORDER BY created_at DESC').all(owner, projectId) as unknown as KbFileRow[]
  }

  /** 未处理完的资料（启动时继续处理）。 */
  listKbUnfinished(): KbFileRow[] {
    return this.db.prepare(`SELECT id, owner, project_id, name, mime, size, sha256, status, note, pages, chunks, embedded, doi, pmid, created_at FROM kb_files WHERE status IN ('pending', 'extracting', 'ocr', 'embedding') OR (status = 'ready' AND embedded < chunks) ORDER BY created_at`).all() as unknown as KbFileRow[]
  }

  updateKbFile(id: string, patch: Partial<Pick<KbFileRow, 'status' | 'note' | 'pages' | 'chunks' | 'embedded' | 'doi' | 'pmid' | 'project_id' | 'name'>>): void {
    const keys = Object.keys(patch) as Array<keyof typeof patch>
    if (keys.length === 0) return
    this.db.prepare(`UPDATE kb_files SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => patch[k] as string | number | null), id)
  }

  deleteKbFile(id: string): void {
    this.db.prepare('DELETE FROM kb_fts WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE file_id = ?)').run(id)
    this.db.prepare('DELETE FROM kb_files WHERE id = ?').run(id)
  }

  /** 写入一份资料的全部文字块（替换旧的）。 */
  putKbChunks(file: { id: string; owner: string }, chunks: Array<{ page: number; text: string }>): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM kb_fts WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE file_id = ?)').run(file.id)
      this.db.prepare('DELETE FROM kb_chunks WHERE file_id = ?').run(file.id)
      const ins = this.db.prepare('INSERT INTO kb_chunks (id, file_id, owner, seq, page, text) VALUES (?, ?, ?, ?, ?, ?)')
      const fts = this.db.prepare('INSERT INTO kb_fts (chunk_id, owner, text) VALUES (?, ?, ?)')
      chunks.forEach((c, i) => {
        const id = `${file.id}-${i}`
        ins.run(id, file.id, file.owner, i, c.page, c.text)
        fts.run(id, file.owner, c.text)
      })
      this.db.exec('COMMIT')
    } catch (err) { this.db.exec('ROLLBACK'); throw err }
  }

  /** 还没向量化的块。 */
  kbChunksToEmbed(fileId: string, limit: number): Array<{ id: string; text: string }> {
    return this.db.prepare('SELECT id, text FROM kb_chunks WHERE file_id = ? AND embedding IS NULL ORDER BY seq LIMIT ?').all(fileId, limit) as Array<{ id: string; text: string }>
  }

  setKbEmbedding(chunkId: string, vector: Float32Array): void {
    this.db.prepare('UPDATE kb_chunks SET embedding = ? WHERE id = ?').run(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), chunkId)
  }

  countKbEmbedded(fileId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE file_id = ? AND embedding IS NOT NULL').get(fileId) as { n: number }).n)
  }

  /** 读一份资料的文字（按页范围），kb_read 用。 */
  kbText(fileId: string, fromPage = 1, toPage = Number.MAX_SAFE_INTEGER): Array<{ page: number; text: string }> {
    return this.db.prepare('SELECT page, text FROM kb_chunks WHERE file_id = ? AND page BETWEEN ? AND ? ORDER BY seq').all(fileId, fromPage, toPage) as Array<{ page: number; text: string }>
  }

  /** 关键词检索（trigram；1–2 个字退回 LIKE），按 bm25 排序。 */
  kbKeywordSearch(owner: string, query: string, limit: number, fileIds?: string[]): KbChunkHit[] {
    const q = query.trim()
    if (!q) return []
    const scope = fileIds ? ` AND c.file_id IN (${fileIds.map(() => '?').join(',') || "''"})` : ''
    const select = `SELECT c.id AS chunk_id, c.file_id, f.name AS file_name, c.page, c.text, f.doi, f.pmid`
    let rows: KbChunkHit[]
    const terms = kbQueryTerms(q)
    if (terms.length > 0) {
      const match = terms.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ')
      rows = this.db.prepare(`${select}, -bm25(kb_fts) AS score FROM kb_fts JOIN kb_chunks c ON c.id = kb_fts.chunk_id JOIN kb_files f ON f.id = c.file_id
        WHERE kb_fts.owner = ? AND kb_fts MATCH ?${scope} ORDER BY bm25(kb_fts) LIMIT ?`).all(owner, match, ...(fileIds ?? []), limit) as never
    } else {
      const like = `%${q.replace(/[%_\\]/g, m => '\\' + m)}%`
      rows = this.db.prepare(`${select}, 1.0 AS score FROM kb_chunks c JOIN kb_files f ON f.id = c.file_id
        WHERE c.owner = ? AND c.text LIKE ? ESCAPE '\\'${scope} ORDER BY c.file_id, c.seq LIMIT ?`).all(owner, like, ...(fileIds ?? []), limit) as never
    }
    return rows
  }

  /** 向量检索：按用户（和资料范围）取出所有向量算余弦（个人资料库规模够用；大了再上 sqlite-vec）。 */
  kbVectorSearch(owner: string, query: Float32Array, limit: number, fileIds?: string[]): KbChunkHit[] {
    const scope = fileIds ? ` AND c.file_id IN (${fileIds.map(() => '?').join(',') || "''"})` : ''
    const rows = this.db.prepare(`SELECT c.id AS chunk_id, c.file_id, f.name AS file_name, c.page, c.text, f.doi, f.pmid, c.embedding
      FROM kb_chunks c JOIN kb_files f ON f.id = c.file_id WHERE c.owner = ? AND c.embedding IS NOT NULL${scope}`).all(owner, ...(fileIds ?? [])) as unknown as Array<KbChunkHit & { embedding: Uint8Array }>
    const scored = rows.map(r => {
      const v = new Float32Array(new Uint8Array(r.embedding).buffer)
      let dot = 0
      for (let i = 0; i < v.length && i < query.length; i++) dot += v[i]! * query[i]!
      const { embedding: _e, ...hit } = r
      return { ...hit, score: dot }
    })
    return scored.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  // —— 设置 ——

  getUserSetting(userId: string, key: string): string | null {
    return (this.db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key) as { value: string } | undefined)?.value ?? null
  }

  setUserSetting(userId: string, key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, key)
    else this.db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value').run(userId, key, value)
  }

  getAppSetting(key: string): string | null {
    return (this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
  }

  setAppSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  // —— 记忆（R3） ——

  private static readonly MEM_COLS = 'id, owner, scope, project_id, kind, content, reason, source, source_doc_id, source_turn_id, status, explicit, created_at, updated_at'

  addMemory(input: Omit<MemoryRow, 'id' | 'created_at' | 'updated_at'> & { norm: string }): MemoryRow {
    const id = 'm' + randomUUID().replace(/-/g, '').slice(0, 11)
    const t = now()
    this.db.prepare(`INSERT INTO memories (id, owner, scope, project_id, kind, content, norm, reason, source, source_doc_id, source_turn_id, status, explicit, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.owner, input.scope, input.project_id, input.kind, input.content, input.norm, input.reason,
      input.source, input.source_doc_id, input.source_turn_id, input.status, input.explicit, t, t)
    return this.getMemory(id)!
  }

  getMemory(id: string): MemoryRow | undefined {
    return this.db.prepare(`SELECT ${Store.MEM_COLS} FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined
  }

  listMemories(owner: string, statuses?: MemoryStatus[]): MemoryRow[] {
    const where = statuses ? ` AND status IN (${statuses.map(() => '?').join(',')})` : ''
    return this.db.prepare(`SELECT ${Store.MEM_COLS} FROM memories WHERE owner = ?${where} ORDER BY updated_at DESC`).all(owner, ...(statuses ?? [])) as unknown as MemoryRow[]
  }

  /** 同一用户里规范化文本相同的记忆（去重、拒绝过的不再提议）。 */
  findMemoryByNorm(owner: string, norm: string): MemoryRow | undefined {
    return this.db.prepare(`SELECT ${Store.MEM_COLS} FROM memories WHERE owner = ? AND norm = ? ORDER BY updated_at DESC`).get(owner, norm) as MemoryRow | undefined
  }

  updateMemory(id: string, patch: Partial<Pick<MemoryRow, 'scope' | 'project_id' | 'kind' | 'content' | 'status' | 'explicit' | 'reason'>> & { norm?: string }): void {
    const keys = Object.keys(patch) as Array<keyof typeof patch>
    if (keys.length === 0) return
    this.db.prepare(`UPDATE memories SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map(k => patch[k] as never), now(), id)
  }

  setMemoryEmbedding(id: string, v: Float32Array | null): void {
    this.db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(v ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null, id)
  }

  /** 有向量的记忆（相似去重、按相关度挑选注入）。 */
  memoryVectors(owner: string, statuses: MemoryStatus[]): Array<{ id: string; v: Float32Array }> {
    const rows = this.db.prepare(`SELECT id, embedding FROM memories WHERE owner = ? AND embedding IS NOT NULL AND status IN (${statuses.map(() => '?').join(',')})`).all(owner, ...statuses) as Array<{ id: string; embedding: Uint8Array }>
    return rows.map(r => ({ id: r.id, v: new Float32Array(new Uint8Array(r.embedding).buffer) }))
  }

  deleteMemory(id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM memory_events WHERE memory_id = ?').run(id)
  }

  /** 清空：owner 给定时只清这个用户，否则清全部（管理员停用记忆）。 */
  clearMemories(owner?: string): number {
    if (owner) {
      this.db.prepare('DELETE FROM memory_events WHERE owner = ?').run(owner)
      return Number(this.db.prepare('DELETE FROM memories WHERE owner = ?').run(owner).changes)
    }
    this.db.exec('DELETE FROM memory_events')
    return Number(this.db.prepare('DELETE FROM memories').run().changes)
  }

  addMemoryEvent(e: Omit<MemoryEventRow, 'id' | 'at'>): void {
    this.db.prepare('INSERT INTO memory_events (id, memory_id, owner, action, actor, before, after, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), e.memory_id, e.owner, e.action, e.actor, e.before, e.after, now())
  }

  memoryEvents(memoryId: string): MemoryEventRow[] {
    return this.db.prepare('SELECT id, memory_id, owner, action, actor, before, after, at FROM memory_events WHERE memory_id = ? ORDER BY at').all(memoryId) as unknown as MemoryEventRow[]
  }

  // —— 项目（文件夹） ——

  createProject(owner: string, name: string): ProjectRow {
    const id = 'p' + randomUUID().replace(/-/g, '').slice(0, 11)
    this.db.prepare('INSERT INTO projects (id, owner, name, created_at) VALUES (?, ?, ?, ?)').run(id, owner, name, now())
    return this.getProject(id)!
  }

  getProject(id: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow | undefined
  }

  listProjects(owner: string): ProjectRow[] {
    return this.db.prepare('SELECT * FROM projects WHERE owner = ? ORDER BY created_at').all(owner) as unknown as ProjectRow[]
  }

  renameProject(id: string, name: string): void {
    this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id)
  }

  /** 删除项目：里面的文档回到「未分组」（不删文档）。 */
  deleteProject(id: string): void {
    this.db.prepare('UPDATE docs SET project_id = NULL WHERE project_id = ?').run(id)
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }

  // —— 全文搜索（FTS5 trigram：3 个字及以上走索引；1–2 个字退回 LIKE） ——

  indexDoc(doc: { id: string; owner: string; title: string }, body: string): void {
    this.db.prepare('DELETE FROM docs_fts WHERE doc_id = ?').run(doc.id)
    this.db.prepare('INSERT INTO docs_fts (doc_id, owner, title, body) VALUES (?, ?, ?, ?)').run(doc.id, doc.owner, doc.title, body)
  }

  unindexDoc(id: string): void {
    this.db.prepare('DELETE FROM docs_fts WHERE doc_id = ?').run(id)
  }

  indexedDocIds(): Set<string> {
    return new Set((this.db.prepare('SELECT doc_id FROM docs_fts').all() as Array<{ doc_id: string }>).map(r => r.doc_id))
  }

  searchDocs(owner: string, query: string, limit = 20): SearchHit[] {
    const q = query.trim()
    if (!q) return []
    const base = `SELECT d.id AS doc_id, d.title, d.kind, d.project_id, d.updated_at, f.body AS body FROM docs_fts f JOIN docs d ON d.id = f.doc_id
      WHERE f.owner = ? AND d.deleted_at IS NULL`
    let rows: Array<{ doc_id: string; title: string; kind: DocKind; project_id: string | null; updated_at: string; body: string }>
    if ([...q].length >= 3) {
      // trigram 匹配：整串当作短语
      const phrase = `"${q.replace(/"/g, '""')}"`
      rows = this.db.prepare(`${base} AND docs_fts MATCH ? ORDER BY bm25(docs_fts, 0, 0, 5, 1) LIMIT ?`).all(owner, phrase, limit) as never
    } else {
      const like = `%${q.replace(/[%_\\]/g, m => '\\' + m)}%`
      rows = this.db.prepare(`${base} AND (f.title LIKE ? ESCAPE '\\' OR f.body LIKE ? ESCAPE '\\') ORDER BY (f.title LIKE ? ESCAPE '\\') DESC, d.updated_at DESC LIMIT ?`).all(owner, like, like, like, limit) as never
    }
    return rows.map(r => ({ doc_id: r.doc_id, title: r.title, kind: r.kind, project_id: r.project_id, updated_at: r.updated_at, snippet: snippetOf(r.title, r.body, q) }))
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

  /** 按给定 id 写入一条引用（复制文档用）。 */
  insertCitation(c: CitationRow): void {
    this.db.prepare('INSERT INTO citations (id, doc_id, doi, pmid, formatted, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, c.doc_id, c.doi, c.pmid, c.formatted, c.url, c.created_at)
  }

  copyNodeSrc(from: string, to: string): void {
    this.db.prepare('INSERT INTO node_src (doc_id, node_id, xml) SELECT ?, node_id, xml FROM node_src WHERE doc_id = ?').run(to, from)
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

  createTurn(input: { user_id: string; doc_id: string | null; message: string; opts?: string }): TurnRow {
    const id = 'r' + randomUUID().replace(/-/g, '').slice(0, 11)
    this.db.prepare('INSERT INTO turns (id, user_id, doc_id, message, status, started_at, opts) VALUES (?, ?, ?, ?, \'running\', ?, ?)')
      .run(id, input.user_id, input.doc_id, input.message, now(), input.opts ?? '{}')
    return this.getTurn(id)!
  }

  getTurn(id: string): TurnRow | undefined {
    return this.db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as unknown as TurnRow | undefined
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

/** 命中处前后各约 30 字，命中词用 [ ] 括起；正文没命中（只命中标题）时取正文开头。 */
function snippetOf(title: string, body: string, q: string): string {
  const at = body.toLowerCase().indexOf(q.toLowerCase())
  if (at < 0) return body.slice(0, 60).replace(/\s+/g, ' ')
  const start = Math.max(0, at - 30)
  const end = Math.min(body.length, at + q.length + 30)
  return `${start > 0 ? '…' : ''}${body.slice(start, at)}[${body.slice(at, at + q.length)}]${body.slice(at + q.length, end)}${end < body.length ? '…' : ''}`.replace(/\s+/g, ' ')
}

const KB_STOPWORDS = new Set(('the and for with how does did what which who whom when where why are was were has have had not but from into than that this these those there their they them then also can could would should may might will about after before over under between during within without among per its our your you any all more most much many other such only very just been being is of to in on at by or as an a vs versus').split(' '))

/**
 * 资料库关键词检索的查询词：自然语言问题拆成英文词（≥3 字符，去停用词）与中文三字片段，用 OR 连接交给 FTS5（trigram）按 bm25 排序。
 * 整句当短语匹配几乎永远命中不了。
 */
export function kbQueryTerms(query: string): string[] {
  const out = new Set<string>()
  for (const m of query.matchAll(/[A-Za-z0-9\u00C0-\u024F][A-Za-z0-9\u00C0-\u024F\-/.]*[A-Za-z0-9\u00C0-\u024F]|[\u3400-\u9fff]+/g)) {
    const t = m[0]
    if (/[\u3400-\u9fff]/.test(t)) {
      if (t.length <= 3) { if (t.length === 3) out.add(t); continue }
      for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3))
    } else if (t.length >= 3 && !KB_STOPWORDS.has(t.toLowerCase())) out.add(t)
  }
  return [...out].slice(0, 48)
}
