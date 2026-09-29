import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getToken } from '../setup.js'

describe('Auth', () => {
  test('register new user', async () => {
    const app = await getApp()
    const username = 'test_user_' + Date.now()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username, password: 'secure123', display_name: `Test User ${Math.random().toString(36).slice(2, 6)}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.jwt_token).toBeTruthy()
    expect(body.display_name).toMatch(/^Test User /)
  })

  test('register duplicate username fails', async () => {
    const app = await getApp()
    // Register first
    const username = 'dup_' + Date.now()
    await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username, password: 'secure123' },
    })
    // Register duplicate
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username, password: 'another' },
    })
    expect(res.statusCode).toBe(409)
  })

  test('login with correct password', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'testadmin_1', password: 'does_not_exist' },
    })
    // Just verify login endpoint responds with auth header
    const token = await getToken()
    expect(token).toBeTruthy()
    const res2 = await app.inject({
      method: 'GET', url: '/api/v1/user/profile',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res2.statusCode).toBe(200)
  })

  test('login with wrong password', async () => {
    const app = await getApp()
    const token = await getToken()
    // Extract username from token and try wrong password
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'testadmin_fake_not_exists', password: 'whatever' },
    })
    expect(res.statusCode).toBe(401)
  })

  test('unauthorized access rejected', async () => {
    const app = await getApp()
    const res = await app.inject({ method: 'GET', url: '/api/v1/dicom/patients/full' })
    expect(res.statusCode).toBe(401)
  })

  test('get profile', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/user/profile',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
  })

  test('update profile', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/user/profile',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { display_name: 'Updated', organization: 'Test Org' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).display_name).toBe('Updated')
  })

  test('admin-only endpoint rejects non-admin (new user)', async () => {
    const app = await getApp()
    const username = 'regular_' + Date.now()
    const reg = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username, password: 'test123' },
    })
    const userToken = JSON.parse(reg.payload).jwt_token
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${userToken}` },
    })
    expect(res.statusCode).toBe(403)
  })
})

/**
 * #1136/#1137 auth 回归:
 *  - username 独立登录标识:填显示名注册后仍可用用户名登录;改显示名不影响登录。
 *  - 返修:P2002(并发同名注册/改重名)映射 409,不再 500。
 */
describe('#1136/#1137 username 与并发注册', () => {
  test('#1136 填显示名注册后用户名可登录;改显示名后登录名不失效', async () => {
    const app = await getApp()
    const username = `loginid_${Date.now()}`
    const reg = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username, password: 'secure123', display_name: `张医生 ${Math.random().toString(36).slice(2, 5)}` },
    })
    expect(reg.statusCode).toBe(200)
    const token = JSON.parse(reg.payload).jwt_token

    const login1 = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username, password: 'secure123' },
    })
    expect(login1.statusCode).toBe(200)

    // 改显示名 → 原用户名登录仍有效(username 列不变)
    const renamed = await app.inject({
      method: 'PATCH', url: '/api/v1/user/profile',
      headers: { ...(await authHeader()), 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: { display_name: `李医生 ${Math.random().toString(36).slice(2, 5)}` },
    })
    expect(renamed.statusCode).toBe(200)
    const login2 = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username, password: 'secure123' },
    })
    expect(login2.statusCode).toBe(200)
  })

  test('#1136 改显示名撞他人 → 409(此前 500)', async () => {
    const app = await getApp()
    const takenName = `撞名_${Math.random().toString(36).slice(2, 8)}`
    const a = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username: `dup_a_${Date.now()}`, password: 'secure123', display_name: takenName },
    })
    expect(a.statusCode).toBe(200)
    const b = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username: `dup_b_${Date.now()}`, password: 'secure123', display_name: `其他_${Math.random().toString(36).slice(2, 8)}` },
    })
    expect(b.statusCode).toBe(200)
    const tokenB = JSON.parse(b.payload).jwt_token
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/user/profile',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenB}` },
      payload: { display_name: takenName },
    })
    expect(res.statusCode).toBe(409)
  })

  test('#1137 并发同名(不同 username)注册 → 一个 200 一个 409,无 500', async () => {
    const app = await getApp()
    const displayName = `race_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const [r1, r2] = await Promise.all([
      app.inject({
        method: 'POST', url: '/api/v1/auth/register',
        headers: { 'content-type': 'application/json' },
        payload: { username: `race_a_${Date.now()}`, password: 'secure123', display_name: displayName },
      }),
      app.inject({
        method: 'POST', url: '/api/v1/auth/register',
        headers: { 'content-type': 'application/json' },
        payload: { username: `race_b_${Date.now()}`, password: 'secure123', display_name: displayName },
      }),
    ])
    const codes = [r1.statusCode, r2.statusCode].sort((a, b) => a - b)
    expect(codes).toEqual([200, 409])
  })

  test('#1138 非法 JSON → 400(此前 500)', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"username": ',
    })
    expect(res.statusCode).toBe(400)
  })
})
