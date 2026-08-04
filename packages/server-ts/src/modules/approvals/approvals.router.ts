import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authGuard } from '../../common/auth.guard.js'
import {
  listPendingApprovals,
  confirmApproval,
  rejectApproval,
  listAuditLogs,
} from './approval.service.js'

const rejectSchema = z.object({
  reason: z.string().optional(),
})

export async function approvalsRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  app.get('/api/v1/approvals/pending', async (request) => {
    const userId = request.user!.userId
    const isAdmin = request.user!.role === 'admin'
    const { targetType } = request.query as any
    const requests = await listPendingApprovals(userId, targetType, isAdmin)
    return { requests }
  })

  app.post('/api/v1/approvals/:id/confirm', async (request, reply) => {
    const userId = request.user!.userId
    const isAdmin = request.user!.role === 'admin'
    const { id } = request.params as any
    try {
      const result = await confirmApproval(userId, id, isAdmin)
      return result
    } catch (err: any) {
      return reply.status(404).send({ error: err.message })
    }
  })

  app.post('/api/v1/approvals/:id/reject', async (request, reply) => {
    const userId = request.user!.userId
    const isAdmin = request.user!.role === 'admin'
    const { id } = request.params as any
    const parsed = rejectSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.format() })
    }
    try {
      const result = await rejectApproval(userId, id, parsed.data.reason ?? null, isAdmin)
      return result
    } catch (err: any) {
      if (err.message === 'rejectedReason required') {
        return reply.status(400).send({ error: err.message })
      }
      return reply.status(404).send({ error: err.message })
    }
  })

  app.get('/api/v1/audit', async (request) => {
    const { targetType, targetId, actor } = request.query as any
    const userId = request.user!.userId
    const isAdmin = request.user!.role === 'admin'
    const logs = await listAuditLogs({ targetType, targetId, actor }, userId, isAdmin)
    return { logs }
  })
}
