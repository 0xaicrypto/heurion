import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'

/**
 * #283/#284/#285: email verification — send-code → bind → login by email
 * → reset-password. The code is delivered to the console in dev mode;
 * the test captures it from the log.
 */

describe('auth email verification (#283)', () => {
  let lastCode: string | null = null

  beforeEach(async () => {
    await (prisma as any).verificationCode.deleteMany({})
    lastCode = null
    // Capture dev-mode codes printed by the verification service.
    const origLog = console.log
    vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      const line = String(args[0] || '')
      const m = line.match(/verification code for ([^ ]+) \(([^)]+)\): (\d{6})/)
      if (m) {
        lastCode = m[3]
      }
      origLog(...args)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('send-code → bind-email → login by email', async () => {
    const app = await getApp()
    const h = await authHeader()
    const hj = { ...h, 'content-type': 'application/json' }
    const userId = await getAuthUserId()
    const email = `doc_${Date.now()}@example.com`

    const sent = await app.inject({
      method: 'POST', url: '/api/v1/auth/send-code',
      headers: hj,
      payload: JSON.stringify({ email, purpose: 'bind' }),
    })
    expect(sent.statusCode).toBe(200)
    expect(lastCode).toBeTruthy()

    const bound = await app.inject({
      method: 'POST', url: '/api/v1/auth/bind-email',
      headers: hj,
      payload: JSON.stringify({ email, code: lastCode }),
    })
    expect(bound.statusCode).toBe(200)
    expect(JSON.parse(bound.payload).email_verified).toBe(true)

    // #336: profile reflects the bound email so the frontend banner
    // disappears after refresh and settings can display the binding.
    const prof = await app.inject({
      method: 'GET', url: '/api/v1/user/profile',
      headers: h,
    })
    expect(prof.statusCode).toBe(200)
    const profileBody = JSON.parse(prof.payload)
    expect(profileBody.email).toBe(email)
    expect(profileBody.email_verified).toBe(true)

    // Login by email (identifier lookup) with the same password.
    const user = await prisma.user.findUnique({ where: { id: userId } })
    const login = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: email, password: 'test123456' }),
    })
    expect(login.statusCode).toBe(200)
    expect(JSON.parse(login.payload).user_id).toBe(userId)
    expect(user).not.toBeNull()
  }, 30000)

  test('wrong code is rejected; send-code throttles; attempts lock after 5', async () => {
    const app = await getApp()
    const h = await authHeader()
    const hj = { ...h, 'content-type': 'application/json' }
    const email = `throttle_${Date.now()}@example.com`

    await app.inject({ method: 'POST', url: '/api/v1/auth/send-code', headers: hj, payload: JSON.stringify({ email, purpose: 'bind' }) })
    const bad = await app.inject({
      method: 'POST', url: '/api/v1/auth/bind-email',
      headers: hj, payload: JSON.stringify({ email, code: '000000' }),
    })
    expect(bad.statusCode).toBe(400)

    const again = await app.inject({ method: 'POST', url: '/api/v1/auth/send-code', headers: hj, payload: JSON.stringify({ email, purpose: 'bind' }) })
    expect(again.statusCode).toBe(400) // throttled

    // #343: each wrong attempt counts; after 5 the code locks even with the
    // correct value.
    for (let i = 0; i < 4; i++) {
      const attempt = await app.inject({
        method: 'POST', url: '/api/v1/auth/bind-email',
        headers: hj, payload: JSON.stringify({ email, code: '111111' }),
      })
      expect(attempt.statusCode).toBe(400)
    }
    const locked = await app.inject({
      method: 'POST', url: '/api/v1/auth/bind-email',
      headers: hj, payload: JSON.stringify({ email, code: lastCode }),
    })
    expect(locked.statusCode).toBe(400)
  }, 30000)

  test('register with optional email + code binds and verifies it', async () => {
    const app = await getApp()
    const username = 'reg_email_' + Date.now()
    const email = `reg_${Date.now()}@example.com`

    await app.inject({
      method: 'POST', url: '/api/v1/auth/send-code',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email, purpose: 'register' }),
    })
    expect(lastCode).toBeTruthy()

    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username, password: 'secure123', email, code: lastCode }),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.jwt_token).toBeTruthy()

    const user = await prisma.user.findUnique({ where: { displayName: username } })
    expect(user?.email).toBe(email)
    expect(user?.emailVerified).toBe(1)

    // The verified email can sign in directly.
    const login = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: email, password: 'secure123' }),
    })
    expect(login.statusCode).toBe(200)
    expect(JSON.parse(login.payload).user_id).toBe(body.user_id)
  }, 30000)

  test('register with email but wrong code is rejected', async () => {
    const app = await getApp()
    const email = `badcode_${Date.now()}@example.com`

    await app.inject({
      method: 'POST', url: '/api/v1/auth/send-code',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email, purpose: 'register' }),
    })

    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'badcode_' + Date.now(), password: 'secure123', email, code: '000000' }),
    })
    expect(res.statusCode).toBe(400)
  }, 30000)

  test('per-IP send-code cap rejects the 6th send from one IP (#344)', async () => {
    const app = await getApp()
    const h = await authHeader()
    const hj = { ...h, 'content-type': 'application/json' }
    const ip = '203.0.113.77'
    const stamp = Date.now()

    let accepted = 0
    let rejected = false
    for (let i = 0; i < 8; i++) {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/auth/send-code',
        headers: { ...hj, 'x-forwarded-for': ip },
        payload: JSON.stringify({ email: `ip_${stamp}_${i}@example.com`, purpose: 'bind' }),
      })
      if (res.statusCode === 200) accepted++
      if (res.statusCode === 400) rejected = true
    }
    expect(accepted).toBe(5)
    expect(rejected).toBe(true)
  }, 30000)

  test('reset-password flow resets and lets the new password login', async () => {
    const app = await getApp()
    const h = await authHeader()
    const hj = { ...h, 'content-type': 'application/json' }
    const userId = await getAuthUserId()
    const email = `reset_${Date.now()}@example.com`

    await app.inject({ method: 'POST', url: '/api/v1/auth/send-code', headers: hj, payload: JSON.stringify({ email, purpose: 'bind' }) })
    await app.inject({ method: 'POST', url: '/api/v1/auth/bind-email', headers: hj, payload: JSON.stringify({ email, code: lastCode }) })

    lastCode = null
    await app.inject({ method: 'POST', url: '/api/v1/auth/send-code', headers: hj, payload: JSON.stringify({ email, purpose: 'reset' }) })
    expect(lastCode).toBeTruthy()

    const reset = await app.inject({
      method: 'POST', url: '/api/v1/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email, code: lastCode, new_password: 'brandnew123' }),
    })
    expect(reset.statusCode).toBe(200)

    const oldLogin = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: email, password: 'test123456' }),
    })
    expect(oldLogin.statusCode).toBe(401)
    const newLogin = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: email, password: 'brandnew123' }),
    })
    expect(newLogin.statusCode).toBe(200)
    expect(JSON.parse(newLogin.payload).user_id).toBe(userId)
  }, 30000)
})
