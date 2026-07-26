import { describe, test, expect } from 'vitest'
import { getApp } from './setup.js'

describe('Knowledge Gap API', () => {
  async function freshUser() {
    const app = await getApp()
    const username = `kgapi_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const register = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username, password: 'test123456', display_name: 'Gap API User' },
    })
    const token = JSON.parse(register.payload).jwt_token
    const userId = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).userId
    return { token, userId, headers: { authorization: `Bearer ${token}` } }
  }

  test('GET /api/v1/knowledge/gaps returns empty list', async () => {
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
    expect(body.gaps).toEqual([])
  })

  test('POST /api/v1/knowledge/gaps creates a gap', async () => {
    const app = await getApp()
    const { headers } = await freshUser()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/gaps',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { content: '测试未解问题', source: 'user' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.id).toBeDefined()
    expect(body.content).toBe('测试未解问题')
    expect(body.status).toBe('open')
    expect(body.source).toBe('user')
  })

  test('POST /api/v1/knowledge/gaps requires content', async () => {
    const app = await getApp()
    const { headers } = await freshUser()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/gaps',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  test('POST /api/v1/knowledge/gaps/:id/answer resolves gap and creates fact', async () => {
    const app = await getApp()
    const { headers, userId } = await freshUser()

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/gaps',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { content: 'Q1', source: 'user' },
    })
    const gap = JSON.parse(create.payload)

    const answer = await app.inject({
      method: 'POST',
      url: `/api/v1/knowledge/gaps/${gap.id}/answer`,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { answer: 'A1' },
    })
    expect(answer.statusCode).toBe(200)
    const body = JSON.parse(answer.payload)
    expect(body.status).toBe('answered')
    expect(body.answerText).toBe('A1')
    expect(body.answerId).toBeDefined()

    // Verify fact was saved
    const ctxModule = await import('../src/modules/chat/user-context.js')
    const ctx = ctxModule.getUserContext(userId)
    const fact = ctx.facts.all().find((f: any) => f.id === body.answerId)
    expect(fact).toBeTruthy()
    expect(fact?.content).toBe('A1')
  })

  test('POST /api/v1/knowledge/gaps/:id/answer requires answer', async () => {
    const app = await getApp()
    const { headers } = await freshUser()
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/gaps',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { content: 'Q1', source: 'user' },
    })
    const gap = JSON.parse(create.payload)

    const answer = await app.inject({
      method: 'POST',
      url: `/api/v1/knowledge/gaps/${gap.id}/answer`,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: {},
    })
    expect(answer.statusCode).toBe(400)
  })

  test('POST /api/v1/knowledge/gaps/:id/ignore marks gap ignored', async () => {
    const app = await getApp()
    const { headers } = await freshUser()
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/gaps',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { content: 'Q1', source: 'user' },
    })
    const gap = JSON.parse(create.payload)

    const ignore = await app.inject({
      method: 'POST',
      url: `/api/v1/knowledge/gaps/${gap.id}/ignore`,
      headers,
    })
    expect(ignore.statusCode).toBe(200)
    const body = JSON.parse(ignore.payload)
    expect(body.status).toBe('ignored')
  })

  test('GET /api/v1/knowledge/gaps filters by status', async () => {
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
      payload: { content: 'Ignored Q', source: 'user' },
    })
    const gap2 = JSON.parse(create2.payload)

    await app.inject({
      method: 'POST',
      url: `/api/v1/knowledge/gaps/${gap2.id}/ignore`,
      headers,
    })

    const openRes = await app.inject({
      method: 'GET',
      url: '/api/v1/knowledge/gaps?status=open',
      headers,
    })
    const openBody = JSON.parse(openRes.payload)
    expect(openBody.gaps.length).toBe(1)
    expect(openBody.gaps[0].content).toBe('Open Q')

    const ignoredRes = await app.inject({
      method: 'GET',
      url: '/api/v1/knowledge/gaps?status=ignored',
      headers,
    })
    const ignoredBody = JSON.parse(ignoredRes.payload)
    expect(ignoredBody.gaps.length).toBe(1)
    expect(ignoredBody.gaps[0].content).toBe('Ignored Q')
  })

  test('answering non-existent gap returns 404', async () => {
    const app = await getApp()
    const { headers } = await freshUser()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/gaps/nonexistent_id/answer',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { answer: 'A1' },
    })
    expect(res.statusCode).toBe(404)
  })
})
