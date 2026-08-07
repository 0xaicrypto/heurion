import { PrismaClient } from '@prisma/client'

/**
 * #284: deduplicate display_name before the unique constraint lands.
 * Keeps the earliest-registered user per name; the rest get a
 * `_dup_<suffix>` rename. Idempotent — safe to run any time.
 */
async function main() {
  const prisma = new PrismaClient()
  const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } })
  const seen = new Map<string, string>() // displayName → kept userId
  let renamed = 0

  for (const u of users) {
    const existing = seen.get(u.displayName)
    if (!existing) {
      seen.set(u.displayName, u.id)
      continue
    }
    if (existing === u.id) continue
    const newName = `${u.displayName}_dup_${u.id.slice(-6)}`
    await prisma.user.update({ where: { id: u.id }, data: { displayName: newName } })
    renamed++
    console.log(`renamed ${u.displayName} → ${newName}`)
  }
  console.log(`dedupe complete: ${renamed} renamed, ${seen.size} unique names`)
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
