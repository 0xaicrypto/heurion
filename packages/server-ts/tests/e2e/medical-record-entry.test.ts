import { describe, test, expect } from 'vitest'
import { getApp, authHeader } from '../setup.js'

async function createPatient(app: any, initials = 'TE') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/dicom/patients/register-manual',
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: { initials, age: 40, sex: 'M' },
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.payload).patient_hash
}

describe('MedicalRecordEntry', () => {
  test('creates a manual entry with confirmed status', async () => {
    const app = await getApp()
    const hash = await createPatient(app)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/patients/${hash}/medical-records`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: {
        type: 'note',
        title: 'Initial visit',
        date: '2026-07-29T10:00:00.000Z',
        content: 'Patient reports chest pain.',
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.id).toBeTruthy()
    expect(body.status).toBe('confirmed')
    expect(body.version).toBe(1)
  })

  test('creates an AI draft with pending_review status', async () => {
    const app = await getApp()
    const hash = await createPatient(app)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/patients/${hash}/medical-records`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: {
        type: 'lab',
        title: 'CBC',
        date: '2026-07-29T10:00:00.000Z',
        content: 'WBC 10.2',
        status: 'pending_review',
        createdBy: 'system',
        sourceJobId: 'job_123',
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.status).toBe('pending_review')
    expect(body.createdBy).toBe('system')
  })

  test('lists entries by patient ordered by date desc', async () => {
    const app = await getApp()
    const hash = await createPatient(app)
    for (const title of ['Old', 'New']) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/patients/${hash}/medical-records`,
        headers: { ...await authHeader(), 'content-type': 'application/json' },
        payload: {
          type: 'note',
          title,
          date: title === 'Old' ? '2026-01-01T00:00:00.000Z' : '2026-07-29T00:00:00.000Z',
          content: title,
        },
      })
    }
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${hash}/medical-records`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const records = JSON.parse(res.payload).records
    expect(records[0].title).toBe('New')
    expect(records[1].title).toBe('Old')
  })

  test('filters by type and status', async () => {
    const app = await getApp()
    const hash = await createPatient(app)
    await app.inject({
      method: 'POST',
      url: `/api/v1/patients/${hash}/medical-records`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { type: 'lab', title: 'L1', date: '2026-07-29T00:00:00.000Z', content: 'x' },
    })
    await app.inject({
      method: 'POST',
      url: `/api/v1/patients/${hash}/medical-records`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { type: 'note', title: 'N1', date: '2026-07-29T00:00:00.000Z', content: 'y' },
    })
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${hash}/medical-records?type=lab`,
      headers: await authHeader(),
    })
    expect(JSON.parse(res.payload).records.every((r: any) => r.type === 'lab')).toBe(true)
  })

  test('gets single entry by id', async () => {
    const app = await getApp()
    const hash = await createPatient(app)
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/patients/${hash}/medical-records`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { type: 'note', title: 'Single', date: '2026-07-29T00:00:00.000Z', content: 'x' },
    })
    const id = JSON.parse(create.payload).id
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${hash}/medical-records/${id}`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).id).toBe(id)
  })

  test('patch creates a new version and keeps previous', async () => {
    const app = await getApp()
    const hash = await createPatient(app)
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/patients/${hash}/medical-records`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { type: 'note', title: 'V1', date: '2026-07-29T00:00:00.000Z', content: 'first' },
    })
    const id = JSON.parse(create.payload).id
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/patients/${hash}/medical-records/${id}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { content: 'second' },
    })
    expect(patch.statusCode).toBe(200)
    const body = JSON.parse(patch.payload)
    expect(body.version).toBe(2)
    expect(body.previousVersionId).toBe(id)
    expect(body.content).toBe('second')
  })

  test('confirms a pending_review entry', async () => {
    const app = await getApp()
    const hash = await createPatient(app)
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/patients/${hash}/medical-records`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { type: 'lab', title: 'Pending', date: '2026-07-29T00:00:00.000Z', content: 'x', status: 'pending_review', createdBy: 'system' },
    })
    const id = JSON.parse(create.payload).id
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/patients/${hash}/medical-records/${id}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { status: 'confirmed' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).status).toBe('confirmed')
  })

  test('rejects a pending_review entry with reason', async () => {
    const app = await getApp()
    const hash = await createPatient(app)
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/patients/${hash}/medical-records`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { type: 'lab', title: 'Reject', date: '2026-07-29T00:00:00.000Z', content: 'x', status: 'pending_review', createdBy: 'system' },
    })
    const id = JSON.parse(create.payload).id
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/patients/${hash}/medical-records/${id}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { status: 'rejected', rejectedReason: 'Incorrect patient' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.status).toBe('rejected')
    expect(body.rejectedReason).toBe('Incorrect patient')
  })

  test('deletes an entry', async () => {
    const app = await getApp()
    const hash = await createPatient(app)
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/patients/${hash}/medical-records`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { type: 'note', title: 'Del', date: '2026-07-29T00:00:00.000Z', content: 'x' },
    })
    const id = JSON.parse(create.payload).id
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/patients/${hash}/medical-records/${id}`,
      headers: await authHeader(),
    })
    expect(del.statusCode).toBe(200)
    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${hash}/medical-records/${id}`,
      headers: await authHeader(),
    })
    expect(get.statusCode).toBe(404)
  })
})
