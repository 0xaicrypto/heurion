import { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import prisma from '../../common/prisma'
import { signToken } from '../../common/jwt'
import { authGuard, adminGuard } from '../../common/auth.guard'
import { loginSchema, registerSchema } from './auth.dto'

export async function authRouter(app: FastifyInstance) {
  app.post('/api/v1/auth/register', async (request, reply) => {
    const body = registerSchema.parse(request.body)
    const existing = await prisma.user.findFirst({ where: { displayName: body.username } })
    if (existing) return reply.status(409).send({ error: 'Username taken' })

    const hash = await bcrypt.hash(body.password, 10)
    const id = `user_${Math.random().toString(36).slice(2, 12)}`
    const now = new Date().toISOString()
    const userCount = await prisma.user.count()
    const role = userCount === 0 ? 'admin' : 'user'
    const displayName = body.display_name || body.displayName || body.username

    await prisma.user.create({
      data: {
        id, displayName, passwordHash: hash, role,
        createdAt: now, updatedAt: now,
      },
    })

    const token = signToken({ userId: id, role, displayName })
    // Match Python backend snake_case format expected by frontend
    return {
      user_id: id,
      jwt_token: token,
      created_at: now,
      role,
      display_name: displayName,
      expires_in_seconds: 86400,
    }
  })

  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body)
    const user = await prisma.user.findFirst({ where: { displayName: body.username } })
    if (!user || !user.passwordHash) return reply.status(401).send({ error: 'Invalid credentials' })
    if (user.disabledAt) return reply.status(403).send({ error: 'Account disabled' })

    const valid = await bcrypt.compare(body.password, user.passwordHash)
    if (!valid) return reply.status(401).send({ error: 'Invalid credentials' })

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date().toISOString() } })
    const token = signToken({ userId: user.id, role: user.role, displayName: user.displayName })
    return {
      jwt_token: token,
      expires_in_seconds: 86400,
      user_id: user.id,
      role: user.role,
      display_name: user.displayName,
    }
  })

  app.get('/api/v1/user/profile', { preHandler: [authGuard] }, async (request) => {
    const user = await prisma.user.findUnique({ where: { id: request.user!.userId } })
    if (!user) return { error: 'User not found' }
    return {
      user_id: user.id,
      display_name: user.displayName,
      created_at: user.createdAt,
      updated_at: user.updatedAt,
      role: user.role,
      organization: user.organization,
      intended_use: user.intendedUse,
      status: user.status,
      tier: user.tier,
    }
  })

  app.patch('/api/v1/user/profile', { preHandler: [authGuard] }, async (request) => {
    const { display_name, displayName, organization, intended_use } = request.body as any
    const name = display_name || displayName
    const data: any = { updatedAt: new Date().toISOString() }
    if (name) data.displayName = name
    if (organization !== undefined) data.organization = organization
    if (intended_use !== undefined) data.intendedUse = intended_use
    await prisma.user.update({ where: { id: request.user!.userId }, data })
    const user = await prisma.user.findUnique({ where: { id: request.user!.userId } })
    return {
      user_id: user!.id,
      display_name: user!.displayName,
      organization: user!.organization,
      intended_use: user!.intendedUse,
    }
  })

  // CI/Staging: clear test data for the authenticated user only.
  // Must NOT run on production — only localhost/staging hostnames accepted.
  app.post('/api/v1/auth/clear-test-data', { preHandler: authGuard }, async (request, reply) => {
    const host = (request.headers.host || '').split(':')[0]
    if (host !== 'localhost' && host !== '127.0.0.1' && !host.startsWith('staging')) {
      return reply.status(403).send({ error: 'clear-test-data is only available on staging' })
    }
    const userId = request.user!.userId
    // Delete research data linked to this user's studies.
    const studyIds = await (prisma as any).researchStudy.findMany({ where: { userId }, select: { id: true } })
    const studyIdList = studyIds.map((s: any) => s.id)
    if (studyIdList.length > 0) {
      await (prisma as any).researchAssessment.deleteMany({ where: { studyId: { in: studyIdList } } })
      await (prisma as any).researchObservation.deleteMany({ where: { studyId: { in: studyIdList } } })
      await (prisma as any).researchScreening.deleteMany({ where: { studyId: { in: studyIdList } } })
      await (prisma as any).researchEnrollment.deleteMany({ where: { studyId: { in: studyIdList } } })
      await (prisma as any).researchStudy.deleteMany({ where: { id: { in: studyIdList } } })
    }
    // Patient records, docs (with cascade snapshots/refs/chat), and sessions for this user only.
    await (prisma as any).patientRecord.deleteMany({ where: { userId } })
    await (prisma as any).doc.deleteMany({ where: { userId } })
    await (prisma as any).session.deleteMany({ where: { userId } })
    return { cleared: true }
  })
}
