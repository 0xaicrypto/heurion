const { PrismaClient } = require('@prisma/client')
const fs = require('fs')
const path = require('path')
const prisma = new PrismaClient()

async function main() {
  const targetUser = process.argv[2] || process.env.CLEAR_TEST_USER || 'HZ'
  const user = await prisma.user.findFirst({ where: { displayName: targetUser } })
  if (!user) {
    console.log(`User ${targetUser} not found, nothing to clear`)
    await prisma.$disconnect()
    return
  }
  const userId = user.id

  const studyIds = await prisma.researchStudy.findMany({ where: { userId }, select: { id: true } })
  const studyIdList = studyIds.map((s) => s.id)
  if (studyIdList.length > 0) {
    await prisma.researchAssessment.deleteMany({ where: { studyId: { in: studyIdList } } })
    await prisma.researchObservation.deleteMany({ where: { studyId: { in: studyIdList } } })
    await prisma.researchScreening.deleteMany({ where: { studyId: { in: studyIdList } } })
    await prisma.researchEnrollment.deleteMany({ where: { studyId: { in: studyIdList } } })
    await prisma.researchStudy.deleteMany({ where: { id: { in: studyIdList } } })
  }
  await prisma.patientRecord.deleteMany({ where: { userId } })
  await prisma.doc.deleteMany({ where: { userId } })
  await prisma.session.deleteMany({ where: { userId } })

  // Clear on-disk twin data for this user only
  const twinDir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId)
  for (const sub of ['event_log.jsonl', 'facts', 'episodes', 'uploads']) {
    const p = path.join(twinDir, sub)
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true })
      }
    } catch (err) {
      console.warn(`Failed to remove ${p}:`, err.message)
    }
  }

  console.log(`Data cleared for user ${targetUser} (${userId})`)
  await prisma.$disconnect()
}
main().catch(async (err) => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
