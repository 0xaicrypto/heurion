import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getToken } from '../setup.js'
import fs from 'fs'
import path from 'path'

/**
 * 补全所有缺失的测试覆盖
 */

describe('Patients 边缘情况', () => {
  test('list patients returns array even when empty', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/dicom/patients/full',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(JSON.parse(res.payload))).toBe(true)
  })
  test('delete non-existent patient handled', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'DELETE', url: '/api/v1/dicom/patients/nonexistent_hash',
      headers: await authHeader(),
    })
    expect([200, 404]).toContain(res.statusCode)
  })
})

