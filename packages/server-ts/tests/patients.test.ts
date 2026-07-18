import { describe, test, expect } from 'vitest'
import { getApp, authHeader } from './setup.js'

describe('Patients', () => {

  let patientHash: string

  test('create patient', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { initials: 'JD', age: 45, sex: 'M', chief_complaint: 'Chest pain' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.patient_hash).toBeDefined()
    patientHash = body.patient_hash
  })

  test('list patients includes created patient', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/dicom/patients/full',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const patients = JSON.parse(res.payload)
    expect(patients.length).toBeGreaterThan(0)
    expect(patients.find((p: any) => p.patient_hash === patientHash)).toBeTruthy()
  })

  test('patient detail returns correct data', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: `/api/v1/dicom/patients/${patientHash}/detail`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.initials).toBe('JD')
    expect(body.age_value).toBe(45)
  })

  test('create second patient', async () => {
    const app = await getApp()
    await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { initials: 'MS', age: 62, sex: 'F', chief_complaint: 'Shortness of breath' },
    })
    // List should now have 2
    const res = await app.inject({
      method: 'GET', url: '/api/v1/dicom/patients/full',
      headers: await authHeader(),
    })
    expect(JSON.parse(res.payload).length).toBeGreaterThanOrEqual(2)
  })

  test('delete patient', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'DELETE', url: `/api/v1/dicom/patients/${patientHash}`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)

    // Detail should 404
    const detail = await app.inject({
      method: 'GET', url: `/api/v1/dicom/patients/${patientHash}/detail`,
      headers: await authHeader(),
    })
    expect(detail.statusCode).toBe(404)
  })
})
