import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getToken } from '../setup.js'
import fs from 'fs'
import path from 'path'

/**
 * 补全所有缺失的测试覆盖
 */

describe('Skills 完整流程', () => {
  test('search all sources returns multiple', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/skills/search?source=all',
      headers: await authHeader(),
    })
    const body = JSON.parse(res.payload)
    expect(body.results.length).toBeGreaterThan(0)
    expect(body.total).toBeGreaterThanOrEqual(body.results.length)
  })
  test('search by keyword filters', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/skills/search?query=imaging&source=all',
      headers: await authHeader(),
    })
    const names = JSON.parse(res.payload).results.map((r: any) => r.name.toLowerCase())
    expect(names.every((n: string) => n.includes('imaging') || n.includes('reader') || n.includes('detection'))).toBe(true)
  })
  test('install non-existent skill still succeeds', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/skills/install',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { identifier: 'custom/my-skill' },
    })
    expect(res.statusCode).toBe(200)
  })
})

