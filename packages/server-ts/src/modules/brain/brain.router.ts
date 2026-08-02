import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import prisma from '../../common/prisma.js'

export async function brainRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  app.get('/api/v1/brain/stats', async (request) => {
    const userId = request.user!.userId
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    const [pending, confirmedToday, totalEntries] = await Promise.all([
      (prisma as any).medicalRecordEntry.count({
        where: { userId, status: 'pending_review' },
      }),
      (prisma as any).medicalRecordEntry.count({
        where: { userId, status: 'confirmed', confirmedAt: { gte: todayStart.toISOString() } },
      }),
      (prisma as any).medicalRecordEntry.count({ where: { userId } }),
    ])

    return {
      pending,
      confirmedToday,
      totalEntries,
    }
  })
}
