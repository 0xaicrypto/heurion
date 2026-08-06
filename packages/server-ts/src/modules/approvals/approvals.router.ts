import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authGuard } from '../../common/auth.guard.js'
import {
  listPendingApprovals,
  confirmApproval,
  rejectApproval,
  listAuditLogs,
} from './approval.service.js'
import prisma from '../../common/prisma.js'

const rejectSchema = z.object({
  reason: z.string().optional(),
})

const ruleSchema = z.object({
  action: z.enum(['approve', 'reject', 'view']),
  resource: z.string().min(1),
  effect: z.enum(['allow', 'deny', 'ask']),
  role: z.string().default('*'),
  priority: z.number().int().default(0),
  enabled: z.number().int().min(0).max(1).default(1),
})

export async function approvalsRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // ── #105: configurable permission rules (admin CRUD) ──────────

  app.get('/api/v1/approvals/rules', async (request, reply) => {
    if (request.user!.role !== 'admin') {
      return reply.status(403).send({ error: 'Admin only' })
    }
    const rows = await (prisma as any).approvalRule.findMany({ orderBy: { priority: 'asc' } })
    return { rules: rows }
  })

  app.post('/api/v1/approvals/rules', async (request, reply) => {
    if (request.user!.role !== 'admin') {
      return reply.status(403).send({ error: 'Admin only' })
    }
    const parsed = ruleSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.format() })
    }
    const now = new Date().toISOString()
    const row = await (prisma as any).approvalRule.create({
      data: { ...parsed.data, createdAt: now, updatedAt: now },
    })
    return row
  })

  app.delete('/api/v1/approvals/rules/:id', async (request, reply) => {
    if (request.user!.role !== 'admin') {
      return reply.status(403).send({ error: 'Admin only' })
    }
    const { id } = request.params as any
    const deleted = await (prisma as any).approvalRule.deleteMany({ where: { id } })
    if (deleted.count === 0) {
      return reply.status(404).send({ error: 'Rule not found' })
    }
    return {}
  })

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
