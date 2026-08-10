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
  } catch (err) {
    console.warn('[sqlite] WAL enable skipped:', (err as Error).message.slice(0, 120))
  }
}

export { Prisma }
export default prisma
