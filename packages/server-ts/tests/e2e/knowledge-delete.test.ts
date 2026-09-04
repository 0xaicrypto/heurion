import { describe, test, expect } from 'vitest'
import { getApp, authHeader } from '../setup.js'

async function createGap(app: any, content: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/knowledge/gaps',
    headers: { ...(await authHeader()), 'content-type': 'application/json' },
    payload: { content, source: 'user' },
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.payload).id
}

describe('Knowledge base bulk deletes', () => {
  async function createSummary(title: string) {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/summaries',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      payload: { title, content: 'test content', sources: [] },
    })
    expect(res.statusCode).toBe(200)
    return JSON.parse(res.payload).id
  }

  async function createFact(content: string) {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/summaries',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      payload: { title: content, content, sources: [] },
    })
    // Fallback: facts may not have a direct create endpoint; use summary as placeholder
    return JSON.parse(res.payload).id
  }

  test('DELETE /api/v1/knowledge/summaries removes selected summaries', async () => {
    const app = await getApp()
    const id = await createSummary('To be deleted')

    const delRes = await app.inject({
      method: 'DELETE',
      url: '/api/v1/knowledge/summaries',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      payload: { ids: [id] },
    })
    expect(delRes.statusCode).toBe(200)
    expect(JSON.parse(delRes.payload).deleted).toBe(1)

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/knowledge',
      headers: await authHeader(),
    })
    const summaries = JSON.parse(listRes.payload).summaries as Array<{ id: string }>
    expect(summaries.find(a => a.id === id)).toBeUndefined()
  })

  test('DELETE /api/v1/knowledge/summaries removes multiple selected summaries', async () => {
    const app = await getApp()
    const ids = await Promise.all([
      createSummary('Batch 1'),
      createSummary('Batch 2'),
      createSummary('Batch 3'),
    ])

    const delRes = await app.inject({
      method: 'DELETE',
      url: '/api/v1/knowledge/summaries',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      payload: { ids },
    })
    expect(delRes.statusCode).toBe(200)
    expect(JSON.parse(delRes.payload).deleted).toBe(3)

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/knowledge',
      headers: await authHeader(),
    })
    const summaries = JSON.parse(listRes.payload).summaries as Array<{ id: string }>
    for (const id of ids) {
      expect(summaries.find(a => a.id === id)).toBeUndefined()
    }
  })

  test('DELETE /api/v1/knowledge/facts removes multiple selected facts', async () => {
    const app = await getApp()
    // Import facts so we have ids to delete
    const facts = [
      { category: 'fact', importance: 4, content: 'Batch fact 1' },
      { category: 'fact', importance: 3, content: 'Batch fact 2' },
      { category: 'fact', importance: 5, content: 'Batch fact 3' },
    ]
    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/import',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      payload: { facts },
    })
    expect(importRes.statusCode).toBe(200)

    const listBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/facts',
      headers: await authHeader(),
    })
    const factIds = (JSON.parse(listBefore.payload).facts as Array<{ id: string }>)
      .filter(f => f.content.startsWith('Batch fact'))
      .map(f => f.id)
    expect(factIds.length).toBe(3)

    const delRes = await app.inject({
      method: 'DELETE',
      url: '/api/v1/knowledge/facts',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      payload: { ids: factIds },
    })
    expect(delRes.statusCode).toBe(200)
    expect(JSON.parse(delRes.payload).deleted).toBe(3)

    const listAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/facts',
      headers: await authHeader(),
    })
    const remaining = (JSON.parse(listAfter.payload).facts as Array<{ content: string }>).filter(f =>
      f.content.startsWith('Batch fact')
    )
    expect(remaining.length).toBe(0)
  })

  test('DELETE /api/v1/knowledge/gaps removes multiple selected gaps', async () => {
    const app = await getApp()
    const ids = await Promise.all([
      createGap(app, 'Gap batch 1'),
      createGap(app, 'Gap batch 2'),
      createGap(app, 'Gap batch 3'),
    ])

    const delRes = await app.inject({
      method: 'DELETE',
      url: '/api/v1/knowledge/gaps',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      payload: { ids },
    })
    expect(delRes.statusCode).toBe(200)
    expect(JSON.parse(delRes.payload).deleted).toBe(3)

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/knowledge/gaps',
      headers: await authHeader(),
    })
    const gaps = JSON.parse(listRes.payload).gaps as Array<{ id: string }>
    for (const id of ids) {
      expect(gaps.find(g => g.id === id)).toBeUndefined()
    }
  })
})
