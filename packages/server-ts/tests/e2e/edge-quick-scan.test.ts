import { describe, test, expect } from 'vitest'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import fs from 'fs'
import path from 'path'

/**
 * 测试覆盖缺口补全
 */

const TEST_DIR = '.nexus/test-gaps'
const SAMPLE_DIR = process.cwd()

describe('quick-scan patient safety', () => {
  test('scan without patient_hash does NOT touch the latest patient', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    // Two patients — the scan must not implicitly target either.
    const p1 = await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { initials: 'QS1', age: 50, sex: 'M', chief_complaint: 'patient one complaint' },
    })
    const hash1 = JSON.parse(p1.payload).patient_hash
    const p2 = await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { initials: 'QS2', age: 60, sex: 'F', chief_complaint: 'patient two complaint' },
    })
    const hash2 = JSON.parse(p2.payload).patient_hash

    // No patient_hash in the request body
    const scan = await app.inject({
      method: 'POST', url: '/api/v1/dicom/studies/nonexistent.dcm/quick-scan',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    })
    expect(scan.statusCode).toBe(200)

    // Neither profile may have received scan/vision content
    const d1 = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/dicom/patients/${hash1}/detail`, headers: await authHeader() })).payload)
    const d2 = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/dicom/patients/${hash2}/detail`, headers: await authHeader() })).payload)
    expect(d1.chief_complaint).not.toContain('[Scan]')
    expect(d1.chief_complaint).not.toContain('[AI Vision]')
    expect(d2.chief_complaint).not.toContain('[Scan]')
    expect(d2.chief_complaint).not.toContain('[AI Vision]')
  }, 30000)

  test('scan with explicit patient_hash only writes to that patient', async () => {
    const app = await getApp()
    const p1 = await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { initials: 'QS3', age: 40, sex: 'M' },
    })
    const hash1 = JSON.parse(p1.payload).patient_hash
    const p2 = await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { initials: 'QS4', age: 70, sex: 'F' },
    })
    const hash2 = JSON.parse(p2.payload).patient_hash

    const scan = await app.inject({
      method: 'POST', url: '/api/v1/dicom/studies/nonexistent.dcm/quick-scan',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ patient_hash: hash2 }),
    })
    expect(scan.statusCode).toBe(200)

    // hash2 may receive content; hash1 must never be touched
    const d2 = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/dicom/patients/${hash2}/detail`, headers: await authHeader() })).payload)
    const d1 = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/dicom/patients/${hash1}/detail`, headers: await authHeader() })).payload)
    expect(d1.chief_complaint ?? '').not.toContain('[Scan]')
    void d2
  }, 30000)
})
