import { PrismaClient, Prisma } from '@prisma/client'

/**
 * #569: SQLite busy_timeout 是 per-connection 的,但 Prisma 默认按
 * num_cpus*2+1 开连接池 — 启动时执行的 PRAGMA 只对当时那条连接生效,
 * 后续连接仍立即 SQLITE_BUSY。生产日志反复出现 "Error: SQLite database
 * error" 即此。强制单连接池 → 所有查询串行、busy_timeout(唯一连接)真正
 * 生效,从根上消除写锁竞争。非 SQLite 不动。
 */
export function resolveDatabaseUrl(raw: string): string {
  if (!raw.startsWith('file:')) return raw
  if (raw.includes('connection_limit')) return raw
  const sep = raw.includes('?') ? '&' : '?'
  return `${raw}${sep}connection_limit=1`
}

const databaseUrl = resolveDatabaseUrl(process.env.DATABASE_URL || 'file:./nexus_server.db')

const prisma = new PrismaClient(
  databaseUrl.startsWith('file:')
    ? { datasources: { db: { url: databaseUrl } } }
    : undefined,
)

/**
 * SQLite WAL optimization (idempotent, persisted in the DB file header):
 * concurrent readers never block writers — the chat workload is
 * read-heavy. Guarded so a failure never blocks startup.
 */
export async function enableSqliteWal(): Promise<void> {
  if (!databaseUrl.startsWith('file:')) return // only SQLite
  try {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL')
    await prisma.$queryRawUnsafe('PRAGMA synchronous=NORMAL').catch(() => {})
    // #553/#569: 写锁竞争(SQLITE_BUSY)是生产 "database error" 根因 —
    // WAL 下读写不互斥,但多写者仍冲突;busy_timeout 让短锁等待而非报错。
    // 配合 connection_limit=1(唯一连接),该 PRAGMA 覆盖所有后续查询。
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout=10000').catch(() => {})
  } catch (err) {
    console.warn('[sqlite] WAL enable skipped:', (err as Error).message.slice(0, 120))
  }
}

export { Prisma }
export default prisma