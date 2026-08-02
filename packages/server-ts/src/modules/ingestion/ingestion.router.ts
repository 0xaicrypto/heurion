import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import { processIngestionJob, serializeJob } from './ingestion.service.js'
import prisma from '../../common/prisma.js'

export async function ingestionRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  app.get('/api/v1/ingestion/jobs', async (request) => {
    const userId = request.user!.userId
    const { patient_hash, status } = request.query as any

    const where: any = { userId }
    if (patient_hash) where.patientHash = patient_hash
    if (status) where.status = status

    const rows = await (prisma as any).ingestionJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })
    return { jobs: rows.map(serializeJob) }
  })

  app.get('/api/v1/ingestion/jobs/:id', async (request, reply) => {
    const userId = request.user!.userId
    const { id } = request.params as any

    const row = await (prisma as any).ingestionJob.findFirst({
      where: { id, userId },
    })
    if (!row) return reply.status(404).send({ error: 'Ingestion job not found' })

    return serializeJob(row)
  })

  // Trigger analysis for a job; returns the job with updated status.
  app.post('/api/v1/ingestion/jobs/:id/process', async (request, reply) => {
    const userId = request.user!.userId
    const { id } = request.params as any

    const row = await (prisma as any).ingestionJob.findFirst({
      where: { id, userId },
    })
    if (!row) return reply.status(404).send({ error: 'Ingestion job not found' })

    return serializeJob(await processIngestionJob(id))
  })
}
