import { describe, test, expect } from 'vitest'
import { getApp, authHeader } from './setup.js'

describe('Auth', () => {
  let token: string


  test('register new user', async () => {
    const app = await getApp()
    // Try a unique username
    const username = 'test_user_' + Date.now()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username, password: 'secure123', display_name: 'Test User' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.jwt_token).toBeDefined()
    expect(body.role).toBe('user')
  })

  test('register duplicate username fails', async () => {
    const app = await getApp()
    // Use same username from setup
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'testadmin', password: 'secure123' },
    })
    expect(res.statusCode).toBe(409)
  })

  test('login with correct password', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'testadmin', password: 'test123456' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.jwt_token).toBeDefined()
    expect(body.display_name).toBeTruthy()
  })

  test('login with wrong password', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'testadmin', password: 'wrongpassword' },
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
    const body = JSON.parse(res.payload)
    expect(body.display_name).toBeTruthy()
    expect(body.user_id).toBeTruthy()
  })
})
