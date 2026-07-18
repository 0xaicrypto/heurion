import { describe, test, expect } from 'vitest'
import { getApp, authHeader } from './setup.js'

describe('Patients', () => {
  test('create patient returns hash and persists', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { initials: 'JD', age: 45, sex: 'M', chief_complaint: 'Chest pain' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.patient_hash).toBeTruthy()
    expect(body.patient_hash.startsWith('patient_')).toBe(true)
    expect(body.initials).toBe('JD')

    // Verify it appears in list
    const list = await app.inject({
      method: 'GET', url: '/api/v1/dicom/patients/full',
      headers: await authHeader(),
    })
    const patients = JSON.parse(list.payload)
    expect(patients.some((p: any) => p.patient_hash === body.patient_hash)).toBe(true)
  })

  test('create multiple patients and list all', async () => {
    const app = await getApp()
    await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { initials: 'AB', age: 30, sex: 'F' },
    })
    await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { initials: 'CD', age: 25, sex: 'M' },
    })
    const list = await app.inject({
      method: 'GET', url: '/api/v1/dicom/patients/full',
      headers: await authHeader(),
    })
    expect(JSON.parse(list.payload).length).toBeGreaterThanOrEqual(2)
  })

  test('patient detail returns complete data', async () => {
    const app = await getApp()
    // Create fresh patient
    const create = await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { initials: 'ZZ', age: 67, sex: 'F', chief_complaint: 'Cough' },
    })
    const hash = JSON.parse(create.payload).patient_hash

    const res = await app.inject({
      method: 'GET', url: `/api/v1/dicom/patients/${hash}/detail`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.initials).toBe('ZZ')
    expect(body.age_value).toBe(67)
    expect(body.sex).toBe('F')
    expect(body.chief_complaint).toBe('Cough')
    expect(body.study_count).toBeGreaterThanOrEqual(0)
  })

  test('delete patient and verify 404', async () => {
    const app = await getApp()
    const create = await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { initials: 'DEL' },
    })
    const hash = JSON.parse(create.payload).patient_hash

    const del = await app.inject({
      method: 'DELETE', url: `/api/v1/dicom/patients/${hash}`,
      headers: await authHeader(),
    })
    expect(del.statusCode).toBe(200)

    const detail = await app.inject({
      method: 'GET', url: `/api/v1/dicom/patients/${hash}/detail`,
      headers: await authHeader(),
    })
    expect(detail.statusCode).toBe(404)
  })

  test('non-existent patient returns 404', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/dicom/patients/nonexistent_hash/detail',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(404)
  })
})
