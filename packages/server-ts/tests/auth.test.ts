import { describe, test, expect } from 'vitest'
import { getApp, authHeader } from './setup.js'

describe('Auth', () => {
  test('register new user', async () => {
    const app = await getApp()
    const username = 'test_user_' + Date.now()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username, password: 'secure123', display_name: 'Test User' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.jwt_token).toBeTruthy()
    expect(body.role).toBe('user')
    expect(body.display_name).toBe('Test User')
  })

  test('register duplicate username fails', async () => {
    const app = await getApp()
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
    expect(body.jwt_token).toBeTruthy()
    expect(body.display_name).toBeTruthy()
    expect(body.role).toBe('admin')
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

  test('login with non-existent user', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'nonexistent_user', password: 'whatever' },
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
    expect(body.role).toBeDefined()
  })

  test('update profile', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/user/profile',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { display_name: 'Updated Name', organization: 'Test Hospital' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.display_name).toBe('Updated Name')
    expect(body.organization).toBe('Test Hospital')
  })

  test('admin-only endpoint rejects non-admin', async () => {
    const app = await getApp()
    // Register a regular user
    const username = 'regular_' + Date.now()
    const reg = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username, password: 'test123', display_name: 'Regular User' },
    })
    const userToken = JSON.parse(reg.payload).jwt_token

    // Try to access admin endpoint
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${userToken}` },
    })
    expect(res.statusCode).toBe(403)
  })
})
