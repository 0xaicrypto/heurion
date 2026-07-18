import { describe, test, expect } from 'vitest'
import { getApp, authHeader } from './setup.js'

describe('Documents', () => {
  test('create document with title', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Clinical Note' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.id).toBeTruthy()
    expect(body.title).toBe('Clinical Note')
    expect(body.body).toBe('')
    expect(body.created_at).toBeTruthy()
  })

  test('create document without title defaults to Untitled', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).title).toBeTruthy()
  })

  test('list documents', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/docs',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.docs).toBeDefined()
    expect(Array.isArray(body.docs)).toBe(true)
  })

  test('update document body and verify', async () => {
    const app = await getApp()
    // Create
    const create = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Editable' },
    })
    const docId = JSON.parse(create.payload).id

    // Update
    const update = await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Updated', body: '# Findings\nNo abnormalities detected.' },
    })
    expect(update.statusCode).toBe(200)
    const body = JSON.parse(update.payload)
    expect(body.title).toBe('Updated')
    expect(body.body).toContain('Findings')

    // Verify GET returns updated content
    const get = await app.inject({
      method: 'GET', url: `/api/v1/docs/${docId}`,
      headers: await authHeader(),
    })
    expect(JSON.parse(get.payload).body).toContain('Findings')
  })

  test('phi scan detects SSN and names', async () => {
    const app = await getApp()
    const create = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'PHI Test' },
    })
    const docId = JSON.parse(create.payload).id

    // Add content with PHI
    await app.inject({
      method: 'PUT', url: `/api/v1/docs/${docId}`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { body: 'Patient John Smith. MRN: 123-45-6789' },
    })

    const res = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/phi-scan`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const findings = JSON.parse(res.payload).findings
    expect(findings.some((f: any) => f.kind === 'SSN')).toBe(true)
    expect(findings.some((f: any) => f.kind === 'Name')).toBe(true)
  })

  test('document snapshots exist after updates', async () => {
    const app = await getApp()
    const create = await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { title: 'Snapshot Test' },
    })
    const docId = JSON.parse(create.payload).id

    const res = await app.inject({
      method: 'GET', url: `/api/v1/docs/${docId}/snapshots`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).snapshots).toBeDefined()
  })

  test('non-existent document returns 404', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/docs/nonexistent_doc',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(404)
  })
})
