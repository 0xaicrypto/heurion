/**
 * #859 — L2 持久缓存存储层(node:sqlite,零新依赖)。
 *
 * 设计要点(#857 定稿):
 *  - 独立文件 /data/db/url_cache.db(生产),与主库解耦:不争锁、不耦合迁移、
 *    可整文件删除;URL_CACHE_DB_PATH env 覆盖(':memory:' 用于测试);
 *  - WAL + busy_timeout=5000;写方实际仅 nexus-server 进程;
 *  - **缓存永不弄坏请求**:所有读写 try/catch,SQLite 故障静默降级为 miss
 *    (open 失败 → cacheDisabled,直到 reset 重试);
 *  - 淘汰:per-store 行数上限(元数据 5000 / page_md 2000),超限按
 *    fetched_at 批量删最旧 10%;单条 >256KB 不缓存;
 *  - stale 语义:过期条目不删除,转为降级数据源(cacheGet 返回 stale 标记),
 *    调用方在上游最终失败时使用。
 */
import fs from 'fs'
import path from 'path'
import { createRequire } from 'node:module'
import { makeLogger } from '../../common/logger.js'

// #859: node:sqlite 用 createRequire 加载 — vite/vitest 对 `import 'node:sqlite'`
// 的静态解析会把 node: 前缀剥掉当 npm 包而失败(builtin 清单未收录);
// createRequire 运行时由 node 原生解析,绕过打包器。类型见 src/types/node-sqlite.d.ts。
const requireNative = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { DatabaseSync } = requireNative('node:sqlite') as any
type Db = InstanceType<typeof DatabaseSync>

const log = makeLogger('tools.url-cache')

const DEFAULT_DB_PATH = '/data/db/url_cache.db'
const MAX_ENTRY_BYTES = 256 * 1024
const EVICT_BATCH_RATIO = 0.1

/** per-store 行数上限 — 元数据/页面正文分档。 */
export function rowCapFor(store: string): number {
  return store === 'page_md' ? 2000 : 5000
}

export interface CacheLookup {
  body: string
  /** true = 已过期(降级数据源 — 仅上游失败时使用)。 */
  stale: boolean
}

let db: Db | null = null
let dbDisabled = false
let disabledReason = ''

function initSchema(d: Db): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS url_cache (
      store       TEXT NOT NULL,
      key         TEXT NOT NULL,
      body        TEXT NOT NULL,
      fetched_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      hits        INTEGER NOT NULL DEFAULT 0,
      size        INTEGER NOT NULL,
      PRIMARY KEY (store, key)
    );
    CREATE INDEX IF NOT EXISTS idx_url_cache_evict ON url_cache(store, fetched_at);
  `)
}

/** 惰性打开;失败 → 永久禁用直到 reset(降级为无缓存直连,绝不弄坏请求)。 */
function ensureDb(): Db | null {
  if (db) return db
  if (dbDisabled) return null
  try {
    const target = process.env.URL_CACHE_DB_PATH || DEFAULT_DB_PATH
    if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true })
    const d = new DatabaseSync(target)
    if (target !== ':memory:') d.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    initSchema(d)
    db = d
    return d
  } catch (err) {
    dbDisabled = true
    disabledReason = (err as Error).message.slice(0, 120)
    log.warn(`url_cache disabled (degrade to no-cache): ${disabledReason}`)
    return null
  }
}

/** 命中查询。null = 无条目/存储不可用;stale=true = 过期(仅降级用)。 */
export function cacheGet(store: string, key: string): CacheLookup | null {
  try {
    const d = ensureDb()
    if (!d) return null
    const row = d.prepare('SELECT body, expires_at FROM url_cache WHERE store = ? AND key = ?').get(store, key) as
      | { body: string | null; expires_at: number | null }
      | undefined
    if (!row || row.body === null) return null
    d.prepare('UPDATE url_cache SET hits = hits + 1 WHERE store = ? AND key = ?').run(store, key)
    return { body: String(row.body), stale: !(row.expires_at !== null && Date.now() <= row.expires_at) }
  } catch {
    return null
  }
}

/** 写入(过大的条目直接拒绝 — 防御性,页面正文本就截断在 20K 字符)。 */
export function cacheSet(store: string, key: string, body: string, ttlMs: number): void {
  try {
    const d = ensureDb()
    if (!d) return
    const size = Buffer.byteLength(body)
    if (size > MAX_ENTRY_BYTES) return
    const now = Date.now()
    d.prepare(
      `INSERT INTO url_cache (store, key, body, fetched_at, expires_at, hits, size)
       VALUES (?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(store, key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at, size = excluded.size`,
    ).run(store, key, body, now, now + ttlMs, size)
    evictIfNeeded(d, store)
  } catch {
    /* 降级 — 缓存写失败绝不影响主流程 */
  }
}

/** 淘汰:超限按 fetched_at 删最旧 10%。 */
function evictIfNeeded(d: Db, store: string): void {
  try {
    const cap = rowCapFor(store)
    const cnt = d.prepare('SELECT COUNT(*) AS n FROM url_cache WHERE store = ?').get(store) as { n: number | bigint }
    const n = Number(cnt?.n ?? 0)
    if (n <= cap) return
    const evict = Math.max(1, Math.ceil(n * EVICT_BATCH_RATIO))
    d.prepare(
      'DELETE FROM url_cache WHERE store = ? AND key IN (SELECT key FROM url_cache WHERE store = ? ORDER BY fetched_at ASC LIMIT ?)',
    ).run(store, store, evict)
  } catch {
    /* 淘汰失败无害 */
  }
}

/** 测试/重置钩子:关闭连接并清除禁用态(下次使用按当前 env 重新打开)。 */
export function resetUrlCacheForTest(): void {
  try { db?.close() } catch { /* already closed */ }
  db = null
  dbDisabled = false
  disabledReason = ''
}
