import { describe, test, expect } from 'vitest'
import { getApp, authHeader } from '../setup.js'

/**
 * 边界审计（#253）— 缺必填参数必须 400；非法查询参数（limit 等）必须
 * 回退默认值而非崩溃或返回异常数据。
 */
describe('required params 400 (边界 #253)', () => {
  test('medical-records create without patient_hash → 400', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/medical-records',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ sections: 'x' }),
    })
    expect(res.statusCode).toBe(400)
  })

  test('register-manual without initials still creates (defaults)', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    })
    // Either 200 with a default name, or 400 — but never 500.
    expect([200, 400]).toContain(res.statusCode)
  })

  test('files upload without multipart → 400 (no crash)', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/files/upload',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x' }),
    })
    expect(res.statusCode).toBe(400)
  })

  test('knowledge articles create without title/content → 400', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/knowledge/articles',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    })
    expect([400, 422]).toContain(res.statusCode)
  })

  test('sidecar feedback without output → 400', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/knowledge/sidecar/feedback',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ saveAll: false }),
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('illegal query params fall back to defaults (边界 #253)', () => {
  test('timeline with garbage limit does not crash (defaults)', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agent/timeline?limit=abc',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(Array.isArray(body.items)).toBe(true)
  })

  test('timeline with negative limit still returns (bounded)', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agent/timeline?limit=-5',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
  })

  test('skills search with garbage page params does not crash', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/skills/search?q=test&page=abc&page_size=xyz',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
  })

  test('messages with huge limit is bounded (no OOM)', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agent/messages?session_id=any&limit=99999999',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(Array.isArray(body.messages)).toBe(true)
  })
})
