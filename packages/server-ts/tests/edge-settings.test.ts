import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getToken } from './setup.js'
import fs from 'fs'
import path from 'path'

/**
 * 补全所有缺失的测试覆盖
 */

describe('Settings 功能', () => {
  test('llm status returns provider and model', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/settings/llm',
      headers: await authHeader(),
    })
    const body = JSON.parse(res.payload)
    expect(body.provider).toBeTruthy()
    expect(body.model).toBeTruthy()
  })
  test('llm test endpoint responds', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/settings/llm/test',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).ok).toBe(true)
  })
  test('update llm settings returns ok', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'PUT', url: '/api/v1/settings/llm',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { provider: 'deepseek', model: 'deepseek-v4-pro' },
    })
    expect(JSON.parse(res.payload).ok).toBe(true)
  })
})

