import { PrismaClient, Prisma } from '@prisma/client'

const prisma = new PrismaClient()

/**
 * SQLite WAL optimization (idempotent, persisted in the DB file header):
 * concurrent readers never block writers — the chat workload is
 * read-heavy. Guarded so a failure never blocks startup.
 */
export async function enableSqliteWal(): Promise<void> {
  const url = process.env.DATABASE_URL || ''
  if (!url.startsWith('file:')) return // only SQLite
  try {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL')
    await prisma.$queryRawUnsafe('PRAGMA synchronous=NORMAL').catch(() => {})
    // #553: SQLite 写锁竞争(SQLITE_BUSY)是生产 "database error" 常见根因 —
    // WAL 下读写不互斥,但多写者仍冲突;busy_timeout 让短锁等待而非报错。
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout=5000').catch(() => {})
  } catch (err) {
    console.warn('[sqlite] WAL enable skipped:', (err as Error).message.slice(0, 120))
  }
}

export { Prisma }
export default prisma
