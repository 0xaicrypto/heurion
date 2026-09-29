import { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import fs from 'fs'
import prisma from '../../common/prisma'
import { signToken } from '../../common/jwt'
import { authGuard } from '../../common/auth.guard'
import { loginSchema, registerSchema } from './auth.dto'
import { evictUserContext } from '../shared/user-context.js'
import { twinsBaseDir } from '../../lib/upload-path.js'

/**
 * P1: clear-test-data 的生产闸门此前只看请求 Host 头 — 任何客户端发
 * `Host: localhost` 就能在生产绕过。现在以环境判定为准（#989：生产走
 * 显式 APP_ENV/NODE_ENV=production），Host 白名单只作为非生产环境的
 * 防御纵深保留。
 */
export function isClearTestDataAllowed(
  hostHeader: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const isProd = env.NODE_ENV === 'production' || env.APP_ENV === 'production'
  if (isProd) return false
  // #staging-removal: 仅本地回环主机 — staging 环境已下线，白名单不再含
  // staging.*；生产环境仍由上面的环境判定直接拒绝。
  const raw = (hostHeader || '').trim()
  const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0]
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

export async function authRouter(app: FastifyInstance) {
  app.post('/api/v1/auth/register', async (request, reply) => {
    const body = registerSchema.parse(request.body)
    const username = String(body.username).trim()
    const displayName = String(body.display_name || body.displayName || username).trim()

    // #1136: 唯一性校验以「登录标识 username + 展示名 displayName」两列为准
    // (此前查 displayName 却把 username 丢了 → 填显示名的用户无法用用户名登录)。
    const existing = await prisma.user.findFirst({
      where: { OR: [{ username }, { displayName }] },
    })
    if (existing) return reply.status(409).send({ error: 'Username taken' })

    // #283: optional email binding at registration — when provided, the
    // code must verify (purpose=register) before the account is created.
    const email = body.email ? String(body.email).trim().toLowerCase() : undefined
    if (email) {
      const { verifyCode } = await import('./verification.service.js')
      const ok = await verifyCode(email, String(body.code || ''), 'register')
      if (!ok) return reply.status(400).send({ error: '验证码无效或已过期' })
      const taken = await prisma.user.findFirst({ where: { email } })
      if (taken) return reply.status(409).send({ error: 'Email already bound to another account' })
    }

    const hash = await bcrypt.hash(body.password, 10)
    // #1137: id 用 crypto.randomUUID(可预测的 Math.random 碰撞面 + 非标准)。
    const id = `user_${crypto.randomUUID()}`
    const now = new Date().toISOString()

    // #1137: 首个用户 admin 判定必须在事务内与 create 原子 — count 与
    // create 分离时并发注册会双双读到 0 而产出多个 admin;SQLite 单连接
    // 事务串行化,count→create 无竞态窗口。唯一约束冲突(P2002)映射 409,
    // 不再 500(并发同名注册的最后一道闸)。
    let created: { id: string; role: string }
    try {
      created = await prisma.$transaction(async (tx) => {
        const userCount = await tx.user.count()
        const role = userCount === 0 ? 'admin' : 'user'
        const user = await tx.user.create({
          data: {
            id, username, displayName, passwordHash: hash, role,
            email: email ?? null,
            emailVerified: email ? 1 : 0,
            createdAt: now, updatedAt: now,
          },
        })
        return { id: user.id, role: user.role }
      })
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        return reply.status(409).send({ error: 'Username taken' })
      }
      throw err
    }

    const token = signToken({ userId: created.id, role: created.role, displayName })
    // Match Python backend snake_case format expected by frontend
    return {
      user_id: created.id,
      jwt_token: token,
      created_at: now,
      role: created.role,
      display_name: displayName,
      expires_in_seconds: 86400,
    }
  })

  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body)
    // #1136: 登录标识 = username(独立列,改名不失效);email/phone/displayName
    // 保留为存量/兼容通道 — 先精确 username,未命中再回退 OR 查找。
    const raw = String(body.username || '').trim()
    const identifier = raw.toLowerCase()
    const byUsername = await prisma.user.findFirst({ where: { username: raw } })
    const user = byUsername ?? await prisma.user.findFirst({
      where: {
        OR: [
          { displayName: raw },
          { email: identifier },
          { phone: raw },
        ],
      },
    })
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

  // ── #283: email verification (send code / bind / reset) ────────────

  app.post('/api/v1/auth/send-code', async (request, reply) => {
    const { email, purpose } = request.body as any
    const { sendVerificationCode } = await import('./verification.service.js')
    try {
      const res = await sendVerificationCode(String(email || ''), (String(purpose || 'bind') as 'bind' | 'register' | 'reset'), request.ip)
      return res
    } catch (err: any) {
      return reply.status(400).send({ error: err.message || 'Failed to send code' })
    }
  })

  app.post('/api/v1/auth/bind-email', { preHandler: [authGuard] }, async (request, reply) => {
    const { email, code } = request.body as any
    const { verifyCode, isValidEmail } = await import('./verification.service.js')
    if (!isValidEmail(String(email || ''))) return reply.status(400).send({ error: 'Invalid email' })
    const ok = await verifyCode(String(email), String(code || ''), 'bind')
    if (!ok) return reply.status(400).send({ error: '验证码无效或已过期' })

    const userId = request.user!.userId
    const taken = await prisma.user.findFirst({ where: { email: String(email).trim().toLowerCase() } })
    if (taken && taken.id !== userId) return reply.status(409).send({ error: 'Email already bound to another account' })

    await prisma.user.update({
      where: { id: userId },
      data: { email: String(email).trim().toLowerCase(), emailVerified: 1, updatedAt: new Date().toISOString() },
    })
    return { ok: true, email: String(email).trim().toLowerCase(), email_verified: true }
  })

  app.post('/api/v1/auth/bind-phone', { preHandler: [authGuard] }, async (request, reply) => {
    const { phone } = request.body as any
    if (!phone || !/^\+?[0-9]{6,15}$/.test(String(phone))) {
      return reply.status(400).send({ error: 'Invalid phone' })
    }
    const userId = request.user!.userId
    const taken = await prisma.user.findFirst({ where: { phone: String(phone) } })
    if (taken && taken.id !== userId) return reply.status(409).send({ error: 'Phone already bound to another account' })
    await prisma.user.update({
      where: { id: userId },
      data: { phone: String(phone), updatedAt: new Date().toISOString() },
    })
    return { ok: true, phone: String(phone) }
  })

  app.post('/api/v1/auth/reset-password', async (request, reply) => {
    const { email, code, new_password } = request.body as any
    const { verifyCode } = await import('./verification.service.js')
    if (!new_password || String(new_password).length < 8) {
      return reply.status(400).send({ error: 'Password must be at least 8 characters' })
    }
    const ok = await verifyCode(String(email || ''), String(code || ''), 'reset')
    if (!ok) return reply.status(400).send({ error: '验证码无效或已过期' })

    const user = await prisma.user.findFirst({ where: { email: String(email).trim().toLowerCase() } })
    if (!user) return reply.status(404).send({ error: 'No account with this email' })

    const hash = await bcrypt.hash(String(new_password), 10)
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hash, updatedAt: new Date().toISOString() } })
    return { ok: true }
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
      email: user.email,
      email_verified: user.emailVerified === 1,
      phone: user.phone,
    }
  })

  app.patch('/api/v1/user/profile', { preHandler: [authGuard] }, async (request, reply) => {
    const { display_name, displayName, organization, intended_use } = request.body as any
    const name = display_name || displayName
    const data: any = { updatedAt: new Date().toISOString() }
    // #1136: 仅改展示名 — username 登录标识不随改名失效。
    if (name) data.displayName = name
    if (organization !== undefined) data.organization = organization
    if (intended_use !== undefined) data.intendedUse = intended_use
    try {
      await prisma.user.update({ where: { id: request.user!.userId }, data })
    } catch (err) {
      // #1137: 改成与他人重名 → 唯一约束冲突映射 409(此前 500)。
      if ((err as { code?: string })?.code === 'P2002') {
        return reply.status(409).send({ error: 'Display name already taken' })
      }
      throw err
    }
    const user = await prisma.user.findUnique({ where: { id: request.user!.userId } })
    return {
      user_id: user!.id,
      display_name: user!.displayName,
      organization: user!.organization,
      intended_use: user!.intendedUse,
    }
  })

  // CI/本地开发: clear test data for the authenticated user only.
  // Must NOT run on production — gated by environment (P1: Host header alone
  // was spoofable with `Host: localhost`).
  app.post('/api/v1/auth/clear-test-data', { preHandler: [authGuard] }, async (request, reply) => {
    if (!isClearTestDataAllowed(request.headers.host)) {
      return reply.status(403).send({ error: 'clear-test-data is only available on a local/test instance' })
    }
    const userId = request.user!.userId
    // Delete research data linked to this user's studies.
    const studyIds = await prisma.researchStudy.findMany({ where: { userId }, select: { id: true } })
    const studyIdList = studyIds.map((s: any) => s.id)
    if (studyIdList.length > 0) {
      await prisma.studyEvent.deleteMany({ where: { studyId: { in: studyIdList } } })
      await prisma.studyProtocolRule.deleteMany({ where: { studyId: { in: studyIdList } } })
      await prisma.researchAssessment.deleteMany({ where: { studyId: { in: studyIdList } } })
      await prisma.researchObservation.deleteMany({ where: { studyId: { in: studyIdList } } })
      await prisma.researchScreening.deleteMany({ where: { studyId: { in: studyIdList } } })
      await prisma.researchEnrollment.deleteMany({ where: { studyId: { in: studyIdList } } })
      await prisma.researchStudy.deleteMany({ where: { id: { in: studyIdList } } })
    }
    // Patient records, docs (with cascade snapshots/refs/chat), and sessions for this user only.
    await prisma.patientRecord.deleteMany({ where: { userId } })
    await prisma.doc.deleteMany({ where: { userId } })
    await prisma.session.deleteMany({ where: { userId } })

    // Wipe the on-disk twin directory so file-based memory stores are also reset.
    evictUserContext(userId)
    const twinDir = twinsBaseDir(userId)
    try {
      fs.rmSync(twinDir, { recursive: true, force: true })
    } catch {
      // Best-effort: continue even if directory is missing or locked.
    }

    return { cleared: true }
  })
}
