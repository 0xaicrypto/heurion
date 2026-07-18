import { describe, test, expect } from 'vitest'
import { getApp, authHeader } from './setup.js'

describe('Research', () => {
  let studyId: string

  test('create study', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/research/studies',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { display_name: 'Lung Cancer Phase II', short_code: 'LC002' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.study_id).toBeDefined()
    expect(body.display_name).toBe('Lung Cancer Phase II')
    studyId = body.study_id
  })

  test('list studies', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/research/studies',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).length).toBeGreaterThan(0)
  })

  test('get study detail', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: `/api/v1/research/studies/${studyId}`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).study_id).toBe(studyId)
  })

  test('enroll patient', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: `/api/v1/research/studies/${studyId}/enrollments`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { patient_hash: 'pat_001', arm: 'Arm A' },
    })
    expect(res.statusCode).toBe(200)
  })

  test('get roster', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: `/api/v1/research/studies/${studyId}/roster`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).length).toBe(1)
  })

  test('eligibility rescan', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: `/api/v1/research/studies/${studyId}/eligibility/rescan`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).scanned).toBe(1)
  })

  test('un-enroll patient', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'DELETE', url: `/api/v1/research/studies/${studyId}/enrollments/pat_001`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).ok).toBe(true)
  })

  test('validate short_code format', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/research/studies',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { display_name: 'Test', short_code: 'invalid code with spaces' },
    })
    expect(res.statusCode).toBe(400)
  })
})
