import { describe, test, expect } from 'vitest'
import { getApp, authHeader } from './setup.js'

describe('Documents', () => {
  let docId: string

  test('create document', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Clinical Note' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.id).toBeDefined()
    expect(body.title).toBe('Clinical Note')
    docId = body.id
  })

  test('list documents', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/docs',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.docs.length).toBeGreaterThan(0)
  })

  test('get document', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: `/api/v1/docs/${docId}`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).body).toBe('')
  })

  test('update document', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Updated Note', body: '# Assessment\nPatient stable.' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.title).toBe('Updated Note')
    expect(body.body).toContain('Patient stable')
  })

  test('phi scan detects names', async () => {
    const app = await getApp()
    // First add content with PHI
    await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { body: 'Patient John Smith with SSN 123-45-6789' },
    })
    const res = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/phi-scan`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.findings.length).toBeGreaterThan(0)
    const ssn = body.findings.find((f: any) => f.kind === 'SSN')
    expect(ssn).toBeTruthy()
  })

  test('document snapshots', async () => {
    const app = await getApp()
    // Get snapshots
    const snapRes = await app.inject({
      method: 'GET', url: `/api/v1/docs/${docId}/snapshots`,
      headers: await authHeader(),
    })
    expect(snapRes.statusCode).toBe(200)
  })

  test('400 on missing required field', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: {},
    })
    expect(res.statusCode).toBe(200) // Title defaults to 'Untitled'
  })
})
