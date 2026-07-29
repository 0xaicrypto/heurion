import { describe, test, expect } from 'vitest'
import { getApp, authHeader } from './setup.js'

async function createPatient(app: any, initials = 'AP') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/dicom/patients/register-manual',
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: { initials, age: 40, sex: 'M' },
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.payload).patient_hash
}

async function createPendingEntry(app: any, hash: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/patients/${hash}/medical-records`,
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: {
      type: 'lab',
      title: 'Pending CBC',
      date: '2026-07-29T00:00:00.000Z',
      content: 'WBC 10.2',
      status: 'pending_review',
      createdBy: 'system',
    },
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.payload)
}

describe('Approval & Audit', () => {
  test('creating pending_review entry creates an approval request', async () => {
    const app = await getApp()
    const hash = await createPatient(app)
    const entry = await createPendingEntry(app, hash)

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: await authHeader(),
    })
    expect(list.statusCode).toBe(200)
    const requests = JSON.parse(list.payload).requests
    const req = requests.find((r: any) => r.targetId === entry.id)
    expect(req).toBeDefined()
    expect(req.targetType).toBe('MedicalRecordEntry')
    expect(req.status).toBe('pending')
  })

  test('confirming approval confirms the target and writes audit log', async () => {
    const app = await getApp()
    const hash = await createPatient(app)
    const entry = await createPendingEntry(app, hash)

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: await authHeader(),
    })
    const req = JSON.parse(list.payload).requests.find((r: any) => r.targetId === entry.id)

    const confirm = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${req.id}/confirm`,
      headers: await authHeader(),
    })
    expect(confirm.statusCode).toBe(200)

    const updated = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${hash}/medical-records/${entry.id}`,
      headers: await authHeader(),
    })
    expect(JSON.parse(updated.payload).status).toBe('confirmed')

    const audit = await app.inject({
      method: 'GET',
      url: `/api/v1/audit?targetType=MedicalRecordEntry&targetId=${entry.id}`,
      headers: await authHeader(),
    })
    expect(audit.statusCode).toBe(200)
    const logs = JSON.parse(audit.payload).logs
    expect(logs.some((l: any) => l.action === 'approval.confirmed')).toBe(true)
  })

  test('rejecting approval with reason rejects the target and writes audit log', async () => {
    const app = await getApp()
    const hash = await createPatient(app)
    const entry = await createPendingEntry(app, hash)

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: await authHeader(),
    })
    const req = JSON.parse(list.payload).requests.find((r: any) => r.targetId === entry.id)

    const reject = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${req.id}/reject`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { reason: 'Incorrect patient' },
    })
    expect(reject.statusCode).toBe(200)

    const updated = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${hash}/medical-records/${entry.id}`,
      headers: await authHeader(),
    })
    const body = JSON.parse(updated.payload)
    expect(body.status).toBe('rejected')
    expect(body.rejectedReason).toBe('Incorrect patient')

    const audit = await app.inject({
      method: 'GET',
      url: `/api/v1/audit?targetType=MedicalRecordEntry&targetId=${entry.id}`,
      headers: await authHeader(),
    })
    const logs = JSON.parse(audit.payload).logs
    expect(logs.some((l: any) => l.action === 'approval.rejected')).toBe(true)
  })

  test('rejecting without reason returns 400', async () => {
    const app = await getApp()
    const hash = await createPatient(app)
    const entry = await createPendingEntry(app, hash)

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: await authHeader(),
    })
    const req = JSON.parse(list.payload).requests.find((r: any) => r.targetId === entry.id)

    const reject = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${req.id}/reject`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: {},
    })
    expect(reject.statusCode).toBe(400)
  })

  test('resolved approvals do not appear in pending list', async () => {
    const app = await getApp()
    const hash = await createPatient(app)
    const entry = await createPendingEntry(app, hash)

    const listBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: await authHeader(),
    })
    const req = JSON.parse(listBefore.payload).requests.find((r: any) => r.targetId === entry.id)

    await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${req.id}/confirm`,
      headers: await authHeader(),
    })

    const listAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: await authHeader(),
    })
    expect(JSON.parse(listAfter.payload).requests.some((r: any) => r.id === req.id)).toBe(false)
  })
})
