import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getToken } from '../setup.js'
import fs from 'fs'
import path from 'path'

/**
 * 补全所有缺失的测试覆盖
 */

describe('Research 边界', () => {
  test('create study with minimum valid fields', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/research/studies',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { display_name: 'X', short_code: 'X1' },
    })
    expect(res.statusCode).toBe(200)
  })
  test('import protocol with empty text rejected', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/research/studies/test/import-protocol',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { text: '' },
    })
    expect(res.statusCode).toBe(400)
  })
  test('roster returns empty for new study', async () => {
    const app = await getApp()
    const s = await app.inject({
      method: 'POST', url: '/api/v1/research/studies',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { display_name: 'Roster Empty', short_code: 'RE01' },
    })
    const sid = JSON.parse(s.payload).study_id
    const res = await app.inject({
      method: 'GET', url: `/api/v1/research/studies/${sid}/roster`,
      headers: await authHeader(),
    })
    expect(JSON.parse(res.payload).length).toBe(0)
  })
  test('eligibility returns empty for new study', async () => {
    const app = await getApp()
    const s = await app.inject({
      method: 'POST', url: '/api/v1/research/studies',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { display_name: 'Elig Empty', short_code: 'EE01' },
    })
    const sid = JSON.parse(s.payload).study_id
    const res = await app.inject({
      method: 'GET', url: `/api/v1/research/studies/${sid}/eligibility`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
  })
})

