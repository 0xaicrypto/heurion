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

  test('wrong code is rejected; send-code throttles', async () => {
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
