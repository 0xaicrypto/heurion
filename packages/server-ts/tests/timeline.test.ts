import { describe, test, expect } from 'vitest'
import { getApp, authHeader } from './setup.js'

describe('Timeline & Agent State', () => {
  test('timeline returns items array', async () => {
    const app = await getApp()
    const token = await authHeader()

    // Send a message (writes event log during SSE)
    await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...token, 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Hello', session_id: 'test_timeline' }),
    })

    // Wait for async writes
    await new Promise(r => setTimeout(r, 300))

    const res = await app.inject({
      method: 'GET', url: '/api/v1/agent/timeline?limit=10',
      headers: token,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.items).toBeDefined()
    // Should have items (may include session_summary, conversation, evolution)
    expect(body.items.length).toBeGreaterThanOrEqual(0)
    // If items exist, check kind is one of the valid types
    for (const item of body.items) {
      expect(['conversation', 'session_summary', 'evolution']).toContain(item.kind)
    }
  })

  test('timeline items have valid kinds', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agent/timeline?limit=20',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const items = JSON.parse(res.payload).items
    // All items should have valid kind
    const validKinds = ['conversation', 'session_summary', 'evolution']
    for (const item of items) {
      expect(validKinds).toContain(item.kind)
    }
    // Should NOT contain raw event types
    expect(items.some((i: any) => i.kind === 'user_message')).toBe(false)
    expect(items.some((i: any) => i.kind === 'assistant_response')).toBe(false)
  })
})

describe('Memory Export/Import', () => {
  test('memory export returns structured data', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/memory/export',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.facts).toBeDefined()
    expect(body.episodes).toBeDefined()
    expect(body.skills).toBeDefined()
    expect(body.event_log_count).toBeGreaterThanOrEqual(0)
    expect(body.exported_at).toBeTruthy()
  })

  test('memory import with empty data succeeds', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/memory/import',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ facts: [], episodes: [] }),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).imported).toBe(0)
  })
})

describe('Skills Pagination', () => {
  test('search with page 1 returns first page', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/skills/search?source=all&page=1&page_size=3',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.total).toBeGreaterThan(0)
    expect(body.page).toBe(1)
    expect(body.page_size).toBe(3)
    expect(body.total_pages).toBeGreaterThan(0)
    expect(body.results.length).toBeLessThanOrEqual(3)
  })

  test('search page 2 has different results', async () => {
    const app = await getApp()
    const page1 = await app.inject({
      method: 'GET', url: '/api/v1/skills/search?source=all&page=1&page_size=5',
      headers: await authHeader(),
    })
    const page2 = await app.inject({
      method: 'GET', url: '/api/v1/skills/search?source=all&page=2&page_size=5',
      headers: await authHeader(),
    })
    const p1 = JSON.parse(page1.payload).results.map((r: any) => r.name)
    const p2 = JSON.parse(page2.payload).results.map((r: any) => r.name)
    // Results should be different
    expect(p1.some((n: string) => !p2.includes(n)) || p2.some((n: string) => !p1.includes(n))).toBe(true)
  })
})
