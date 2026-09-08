import { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import prisma from '../../common/prisma'
import { adminGuard } from '../../common/auth.guard'
import { queryLoki, type LogQueryFilters } from '../../common/log-query'

export async function adminRouter(app: FastifyInstance) {
  app.addHook('preHandler', adminGuard)

  // ── #801: AI 日志检索 — 语义过滤键代理 Loki,紧凑 JSON 输出 ──
  // query_logs agent 工具与外部 AI 共用此出口;adminGuard 挡非管理员。
  app.get('/api/v1/admin/logs', async (request, reply) => {
    const q = request.query as any
    const filters: LogQueryFilters = {
      container: q.container,
      module: q.module,
      level: q.level,
      sessionId: q.session_id || q.sessionId,
      docId: q.docId,
      fileId: q.fileId,
      tool: q.tool,
      q: q.q,
      since: q.since,
      limit: Math.min(Number(q.limit) || 200, 500),
    }
    const result = await queryLoki(filters)
    if (result.error) return reply.status(502).send({ error: result.error })
    return { lines: result.lines, total: result.total }
  })

  // ── List users (frontend expects { users: [...] }) ──
  app.get('/api/v1/admin/users', async () => {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, displayName: true, email: true, role: true, createdAt: true, disabledAt: true, lastLoginAt: true },
    })
    return {
      users: users.map((u: any) => ({
        user_id: u.id,
        username: u.displayName,
        email: u.email || '',
        role: u.role,
        created_at: u.createdAt,
        disabled_at: u.disabledAt,
        last_login_at: u.lastLoginAt,
        has_password: true,
      })),
    }
  })

  // ── Disable user ──
  app.post('/api/v1/admin/users/:userId/disable', async (request, reply) => {
    const { userId } = request.params as any
    const now = new Date().toISOString()
    try {
      await prisma.user.update({ where: { id: userId }, data: { disabledAt: now } })
      return { user_id: userId, disabled_at: now, ok: true }
    } catch {
      return reply.status(404).send({ error: 'User not found' })
    }
  })

  // ── Enable user ──
  app.post('/api/v1/admin/users/:userId/enable', async (request, reply) => {
    const { userId } = request.params as any
    try {
      await prisma.user.update({ where: { id: userId }, data: { disabledAt: null } })
      return { user_id: userId, disabled_at: null, ok: true }
    } catch {
      return reply.status(404).send({ error: 'User not found' })
    }
  })

  // ── Reset password ──
  app.post('/api/v1/admin/users/:userId/reset-password', async (request, reply) => {
    const { userId } = request.params as any
    const { new_password } = request.body as any
    if (!new_password) return reply.status(400).send({ error: 'new_password required' })
    const hash = await bcrypt.hash(new_password, 10)
    try {
      await prisma.user.update({ where: { id: userId }, data: { passwordHash: hash } })
      return { user_id: userId, ok: true }
    } catch {
      return reply.status(404).send({ error: 'User not found' })
    }
  })
}
