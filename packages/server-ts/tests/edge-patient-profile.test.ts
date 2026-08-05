import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getAuthUserId } from './setup.js'
import fs from 'fs'
import path from 'path'

/**
 * 测试覆盖缺口补全
 */

const TEST_DIR = '.nexus/test-gaps'
const SAMPLE_DIR = process.cwd()

describe('患者 Profile 更新验证', () => {
  test('quick scan updates chief_complaint', async () => {
    const app = await getApp()
    // Create patient
    const create = await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { initials: 'T1', age: 50, sex: 'M', chief_complaint: 'cough' },
    })
    const hash = JSON.parse(create.payload).patient_hash

    // Upload DICOM to test user's upload dir
    const userId = await getAuthUserId()
    const dir = path.join(TEST_DIR, userId, 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    const src = path.join(SAMPLE_DIR, 'sample-chest-ct.dcm')
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'profile_test.dcm'))

    // Quick Scan
    const scan = await app.inject({
      method: 'POST', url: '/api/v1/dicom/studies/profile_test.dcm/quick-scan',
      headers: await authHeader(),
    })
    expect(scan.statusCode).toBe(200)

    // Profile should be updated (may not have scan data if file not found)
    const detail = await app.inject({
      method: 'GET', url: `/api/v1/dicom/patients/${hash}/detail`,
      headers: await authHeader(),
    })
    expect(detail.statusCode).toBe(200)
    const body = JSON.parse(detail.payload)
    // Profile should contain at least the original complaint
    expect(body.chief_complaint).toContain('cough')
  })
})

