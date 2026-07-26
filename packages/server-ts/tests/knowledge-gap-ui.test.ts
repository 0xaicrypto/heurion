import { describe, test, expect, beforeEach } from 'vitest'
import { getApp, authHeader } from './setup.js'
import prisma from '../src/common/prisma'
import { FactsStore } from '../src/evolution/stores'
import { InMemoryKnowledgeGapService } from '../src/modules/knowledge/knowledge-gap.service'
import path from 'path'
import os from 'os'

async function clearGaps() {
  try {
    await (prisma as any).knowledgeGap.deleteMany({})
  } catch {
    // table may not exist in some test configurations
  }
}

describe('Knowledge Gap UI improvements', () => {
  async function freshUser() {
    const app = await getApp()
    const username = `kgap_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const register = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username, password: 'test123456', display_name: 'Gap UI User' },
    })
    const token = JSON.parse(register.payload).jwt_token
    return { token, headers: { authorization: `Bearer ${token}` } }
  }

  test('GET /api/v1/knowledge/gaps returns paginated shape', async () => {
    const app = await getApp()
    const { headers } = await freshUser()
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/knowledge/gaps',
      headers,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.gaps).toBeDefined()
    expect(body.pagination).toBeDefined()
    expect(body.pagination.page).toBe(1)
    expect(body.pagination.pageSize).toBe(50)
    expect(body.pagination.total).toBe(0)
  })

  test('pagination splits results correctly', async () => {
    const app = await getApp()
    const { headers } = await freshUser()
    const marker = `pg_${Date.now()}`
    for (let i = 0; i < 15; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/knowledge/gaps',
        headers: { ...headers, 'content-type': 'application/json' },
        payload: { content: `Q${i} ${marker}`, source: 'user' },
      })
    }

    const page1 = await app.inject({
      method: 'GET',
      url: `/api/v1/knowledge/gaps?q=${marker}&page=1&pageSize=10`,
      headers,
    })
    const body1 = JSON.parse(page1.payload)
    expect(body1.gaps.length).toBe(10)
    expect(body1.pagination.total).toBe(15)
    expect(body1.pagination.totalPages).toBe(2)

    const page2 = await app.inject({
      method: 'GET',
      url: `/api/v1/knowledge/gaps?q=${marker}&page=2&pageSize=10`,
      headers,
    })
    const body2 = JSON.parse(page2.payload)
    expect(body2.gaps.length).toBe(5)
  })

  test('search filters by substring', async () => {
    const app = await getApp()
    const { headers } = await freshUser()
    const marker = `srch_${Date.now()}`
    await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/gaps',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { content: `EGFR mutation prevalence ${marker}A`, source: 'user' },
    })
    await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/gaps',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { content: `KRAS mutation prevalence ${marker}B`, source: 'user' },
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/knowledge/gaps?q=${marker}A`,
      headers,
    })
    const body = JSON.parse(res.payload)
    expect(body.gaps.length).toBe(1)
    expect(body.gaps[0].content).toContain('EGFR')
  })

  test('source filter works', async () => {
    const app = await getApp()
    const { headers } = await freshUser()
    await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/gaps',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { content: 'Chat Q', source: 'chat' },
    })
    await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/gaps',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { content: 'Sidecar Q', source: 'sidecar' },
    })

    const chatRes = await app.inject({
      method: 'GET',
      url: '/api/v1/knowledge/gaps?source=chat',
      headers,
    })
    const chatBody = JSON.parse(chatRes.payload)
    expect(chatBody.gaps.length).toBe(1)
    expect(chatBody.gaps[0].content).toBe('Chat Q')

    const sidecarRes = await app.inject({
      method: 'GET',
      url: '/api/v1/knowledge/gaps?source=sidecar',
      headers,
    })
    const sidecarBody = JSON.parse(sidecarRes.payload)
    expect(sidecarBody.gaps.length).toBe(1)
    expect(sidecarBody.gaps[0].content).toBe('Sidecar Q')
  })

  test('GET /api/v1/knowledge/gaps/dashboard returns stats', async () => {
    const app = await getApp()
    const { headers } = await freshUser()
    await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/gaps',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { content: 'Open Q', source: 'user' },
    })
    const create2 = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/gaps',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { content: 'Answered Q', source: 'chat' },
    })
    const gap2 = JSON.parse(create2.payload)
    await app.inject({
      method: 'POST',
      url: `/api/v1/knowledge/gaps/${gap2.id}/answer`,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { answer: 'A' },
    })

    const dashRes = await app.inject({
      method: 'GET',
      url: '/api/v1/knowledge/gaps/dashboard',
      headers,
    })
    expect(dashRes.statusCode).toBe(200)
    const dash = JSON.parse(dashRes.payload)
    expect(dash.total).toBe(2)
    expect(dash.open).toBe(1)
    expect(dash.answered).toBe(1)
    expect(dash.ignored).toBe(0)
    expect(dash.bySource.user).toBe(1)
    expect(dash.bySource.chat).toBe(1)
    expect(dash.resolutionRate).toBe(1)
  })

  test('GET /api/v1/knowledge/gaps/:id/suggest returns relevant facts', async () => {
    const app = await getApp()
    const { headers } = await freshUser()

    // Seed fact through the API by answering another gap
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/gaps',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { content: 'EGFR mutation prevalence', source: 'user' },
    })
    const gap = JSON.parse(create.payload)

    await app.inject({
      method: 'POST',
      url: `/api/v1/knowledge/gaps/${gap.id}/answer`,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { answer: 'EGFR exon 19 deletion accounts for ~45% of EGFR mutations' },
    })

    const create2 = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/gaps',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { content: 'What about EGFR mutations', source: 'user' },
    })
    const gap2 = JSON.parse(create2.payload)

    const suggestRes = await app.inject({
      method: 'GET',
      url: `/api/v1/knowledge/gaps/${gap2.id}/suggest`,
      headers,
    })
    expect(suggestRes.statusCode).toBe(200)
    const body = JSON.parse(suggestRes.payload)
    expect(body.suggestions).toBeDefined()
    expect(body.suggestions.length).toBeGreaterThan(0)
    expect(body.suggestions[0]).toContain('EGFR')
  })

  test('suggest for non-existent gap returns 404', async () => {
    const app = await getApp()
    const { headers } = await freshUser()
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/knowledge/gaps/nonexistent/suggest',
      headers,
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('KnowledgeGapService — unit', () => {
  test('InMemory service paginates, filters, and suggests', async () => {
    const service = new InMemoryKnowledgeGapService()
    await service.create({ userId: 'u1', workspaceId: 'ws1', content: 'EGFR question', source: 'chat' })
    await service.create({ userId: 'u1', workspaceId: 'ws1', content: 'KRAS question', source: 'chat' })
    await service.create({ userId: 'u1', workspaceId: 'ws1', content: 'Sidecar question', source: 'sidecar' })

    const page = await service.list({ workspaceId: 'ws1', page: 1, pageSize: 2 })
    expect(page.gaps.length).toBe(2)
    expect(page.pagination.total).toBe(3)

    const search = await service.list({ workspaceId: 'ws1', q: 'EGFR' })
    expect(search.gaps.length).toBe(1)

    const source = await service.list({ workspaceId: 'ws1', source: 'sidecar' })
    expect(source.gaps.length).toBe(1)

    const facts = new FactsStore(path.join(os.tmpdir(), `kgap-facts-${Date.now()}`))
    facts.add({ category: 'fact', importance: 5, content: 'EGFR exon 19 deletion is common', sourceType: 'general' })

    const egfrGap = page.gaps.find(g => g.content.includes('EGFR'))
    expect(egfrGap).toBeDefined()
    const suggestions = await service.suggestAnswer(egfrGap!.id, facts.all(), [])
    expect(suggestions.length).toBeGreaterThan(0)
  })
})
