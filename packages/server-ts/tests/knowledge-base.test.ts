import { describe, test, expect } from 'vitest'
import { getApp, authHeader } from './setup.js'
import crypto from 'crypto'

describe('P0 — File Dedup + Facts', () => {
  test('upload same file twice returns same file_id', async () => {
    const app = await getApp()
    const content = crypto.randomBytes(1024).toString('base64')

    // First upload
    const r1 = await app.inject({
      method: 'POST', url: '/api/v1/files/upload',
      headers: { ...await authHeader() },
      payload: { file: { filename: 'test.txt', data: Buffer.from(content) } },
    } as any)
    expect(r1.statusCode).toBe(200)
    const id1 = JSON.parse(r1.payload).file_id

    // Second upload — same content
    const r2 = await app.inject({
      method: 'POST', url: '/api/v1/files/upload',
      headers: { ...await authHeader() },
      payload: { file: { filename: 'test-copy.txt', data: Buffer.from(content) } },
    } as any)
    expect(r2.statusCode).toBe(200)
    const id2 = JSON.parse(r2.payload).file_id

    // Same content → same file_id (dedup working)
    expect(id1).toBe(id2)
  })

  test('upload different files returns different file_ids', async () => {
    const app = await getApp()
    const r1 = await app.inject({
      method: 'POST', url: '/api/v1/files/upload',
      headers: { ...await authHeader() },
      payload: { file: { filename: 'a.txt', data: Buffer.from('hello') } },
    } as any)
    const r2 = await app.inject({
      method: 'POST', url: '/api/v1/files/upload',
      headers: { ...await authHeader() },
      payload: { file: { filename: 'b.txt', data: Buffer.from('world') } },
    } as any)
    expect(r1.statusCode).toBe(200)
    expect(r2.statusCode).toBe(200)
    expect(JSON.parse(r1.payload).file_id).not.toBe(JSON.parse(r2.payload).file_id)
  })

  test('file list returns uploaded files', async () => {
    const app = await getApp()
    const r = await app.inject({
      method: 'GET', url: '/api/v1/files?limit=50',
      headers: await authHeader(),
    } as any)
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.payload)
    expect(body).toHaveProperty('files')
    expect(body).toHaveProperty('total')
    expect(Array.isArray(body.files)).toBe(true)
    if (body.files.length > 0) {
      const f = body.files[0]
      expect(f).toHaveProperty('file_id')
      expect(f).toHaveProperty('name')
      expect(f).toHaveProperty('size_bytes')
    }
  })

  test('delete file works', async () => {
    const app = await getApp()
    // Upload a file first
    const up = await app.inject({
      method: 'POST', url: '/api/v1/files/upload',
      headers: { ...await authHeader() },
      payload: { file: { filename: 'to-delete.txt', data: Buffer.from('delete me') } },
    } as any)
    const fileId = JSON.parse(up.payload).file_id

    // Delete it
    const del = await app.inject({
      method: 'DELETE', url: `/api/v1/files/${fileId}`,
      headers: await authHeader(),
    } as any)
    expect(del.statusCode).toBe(200)
    expect(JSON.parse(del.payload)).toHaveProperty('deleted', true)
  })

  test('FactsStore dedup — same content merges with count++', async () => {
    const app = await getApp()

    // Create a fact via the test user context
    const ctx = await getUserContext(app)
    const store = ctx.facts

    // Add same content twice
    store.add({ category: 'preference', importance: 3, content: 'Prefer Chinese' })
    store.add({ category: 'preference', importance: 3, content: 'Prefer Chinese' })

    const all = store.all()
    const matching = all.filter((f: any) => f.content === 'Prefer Chinese')
    expect(matching.length).toBe(1)
    expect(matching[0].count).toBeGreaterThanOrEqual(2)
  })

  test('FactsStore — different content stored separately', async () => {
    const app = await getApp()
    const ctx = await getUserContext(app)
    const store = ctx.facts

    store.add({ category: 'fact', importance: 4, content: 'RUL nodule 18mm' })
    store.add({ category: 'fact', importance: 3, content: 'CEA 3.2 normal' })

    const all = store.all()
    expect(all.length).toBeGreaterThanOrEqual(2)
  })

  test('FactsStore — importance increments on duplicate', async () => {
    const app = await getApp()
    const ctx = await getUserContext(app)
    const store = ctx.facts

    store.add({ category: 'fact', importance: 3, content: 'Test importance merge' })
    store.add({ category: 'fact', importance: 4, content: 'Test importance merge' })

    const all = store.all()
    const f = all.find((x: any) => x.content === 'Test importance merge')
    expect(f).toBeTruthy()
    expect(f.importance).toBeGreaterThanOrEqual(4) // max of the two
  })
})

// Helper to get user context directly from the test app
async function getUserContext(app: any) {
  const auth = await authHeader()
  // Create a unique test user to isolate
  const r = await app.inject({
    method: 'GET', url: '/api/v1/user/profile',
    headers: auth,
  } as any)
  const userId = JSON.parse(r.payload).user_id
  const { FactsStore } = await import('../src/evolution/stores.js')
  const baseDir = `.nexus/twins/${userId}`
  const fs = await import('fs')
  fs.mkdirSync(`${baseDir}/facts`, { recursive: true })
  return { facts: new FactsStore(baseDir) }
}
