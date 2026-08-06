import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getToken } from '../setup.js'
import fs from 'fs'
import path from 'path'

/**
 * 补全所有缺失的测试覆盖
 */

describe('Documents 边界', () => {
  test('update non-existent doc returns 404', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'PUT', url: '/api/v1/docs/nonexistent',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'test' },
    })
    expect(res.statusCode).toBe(404)
  })
  test('phi scan on empty doc returns empty', async () => {
    const app = await getApp()
    const d = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Empty' },
    })
    const did = JSON.parse(d.payload).id
    const res = await app.inject({
      method: 'POST', url: `/api/v1/docs/${did}/phi-scan`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).findings.length).toBe(0)
  })
})

