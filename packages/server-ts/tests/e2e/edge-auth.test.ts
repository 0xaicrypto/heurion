import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getToken } from '../setup.js'
import fs from 'fs'
import path from 'path'

/**
 * 补全所有缺失的测试覆盖
 */

describe('Auth 边界', () => {
  test('register with empty username rejected', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username: '', password: 'test123' },
    })
    expect(res.statusCode).toBe(400)
  })
  test('register with short password rejected', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'valid', password: '12' },
    })
    expect(res.statusCode).toBe(400)
  })
  test('login with empty body rejected', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })
})

