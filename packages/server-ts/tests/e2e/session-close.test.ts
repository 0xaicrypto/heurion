import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('multi-session management (#115)', () => {
  test('creates global sessions with scope/status and lists them', async () => {
    const app = await getApp()
    const userId = (await import('../setup.js')).getAuthUserId ? undefined : undefined

    const a = await app.inject({
      method: 'POST', url: '/api/v1/sessions',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ title: '肺癌讨论', scope: 'global' }),
    })
    expect(a.statusCode).toBe(200)
    const sa = JSON.parse(a.payload)
    expect(sa.scope).toBe('global')
    expect(sa.status).toBe('open')

    const b = await app.inject({
      method: 'POST', url: '/api/v1/sessions',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ title: '化疗方案', scope: 'global' }),
    })
    expect(b.statusCode).toBe(200)

    const list = await app.inject({
      method: 'GET', url: '/api/v1/sessions?scope=global',
      headers: await authHeader(),
    })
    const { sessions } = JSON.parse(list.payload)
    expect(sessions.filter((s: any) => [sa.id, JSON.parse(b.payload).id].includes(s.id)).length).toBe(2)
    expect(sessions.every((s: any) => s.scope === 'global')).toBe(true)
  })

  test('closing a session sets status closed and triggers summarize→pending', async () => {
    const app = await getApp()
    const sessionId = `ms_${Date.now()}`

    // Seed events + a summary mock
    const { deepseekChat } = await import('../../src/common/llm.js')
    vi.mocked(deepseekChat).mockImplementation((messages) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      if (text.includes('临床对话摘要器')) return Promise.resolve('## Objective\n测试会话\n\n## 下一步\n1. 复查')
      return Promise.resolve('收到。')
    })
    await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'ZQ 情况如何', session_id: sessionId }),
    })

    // Create the session row in the DB so close can find it
    await (prisma as any).session.create({
      data: { id: sessionId, userId: (await import('../setup.js')).getAuthUserId ? '' : '', title: 'T', scope: 'global', status: 'open', createdAt: new Date().toISOString() },
    }).catch(() => {})

    // Close it via the session's owner — need the real user id
    const tokenPayload = JSON.parse(Buffer.from((await (await import('../setup.js')).authHeader()).authorization.split('.')[1], 'base64').toString())
    await (prisma as any).session.updateMany({ where: { id: sessionId }, data: { userId: tokenPayload.userId } })

    const close = await app.inject({
      method: 'POST', url: `/api/v1/sessions/${sessionId}/close`,
      headers: await authHeader(),
    })
    expect(close.statusCode).toBe(200)
    const body = JSON.parse(close.payload)
    expect(body.status).toBe('closed')

    // Session row updated
    const row = await (prisma as any).session.findUnique({ where: { id: sessionId } })
    expect(row.status).toBe('closed')
    expect(row.closedAt).toBeTruthy()

    // Closing no longer enqueues an episode_summary proposal — summaries
    // are Session Memory (draft layer), facts flow via the close flush.
    await new Promise((r) => setTimeout(r, 500))
    const proposals = await (prisma as any).memoryProposal.findMany({
      where: { kind: 'episode_summary', status: 'pending' },
      orderBy: { createdAt: 'desc' },
    })
    expect(proposals.some((p: any) => p.content.includes('Objective') || p.content.includes('患者重要信息'))).toBe(false)
  }, 30000)

  test('closing a nonexistent session returns 404', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/sessions/nonexistent_zzz/close',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('closing the default global session', () => {
  test('global-{userId} sessions can be closed even without a Session row', async () => {
    const app = await getApp()
    const userId = (await import('../setup.js')).getAuthUserId ? '' : ''
    const { getAuthUserId } = await import('../setup.js')
    const uid = await getAuthUserId()
    const sessionId = `global-${uid}`

    // Seed events so the summarize path has content
    const { deepseekChat } = await import('../../src/common/llm.js')
    vi.mocked(deepseekChat).mockImplementation((messages) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      if (text.includes('临床对话摘要器')) return Promise.resolve('## Objective\n测试')
      return Promise.resolve('ok')
    })
    await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'hello world', session_id: sessionId }),
    })

    const res = await app.inject({
      method: 'POST', url: `/api/v1/sessions/${sessionId}/close`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.status).toBe('closed')

    // Events wiped
    const ctx = (await import('../../src/modules/chat/user-context.js')).getUserContext(uid)
    const remaining = ctx.eventLog.query({ sessionId })
    expect(remaining.length).toBe(0)

    // Legacy default-session rows are deleted outright and never listed.
    const prisma = (await import('../../src/common/prisma.js')).default
    const row = await prisma.session.findFirst({ where: { id: sessionId } })
    expect(row).toBeNull()
    const list = await app.inject({ method: 'GET', url: '/api/v1/sessions', headers: await authHeader() })
    const listed = JSON.parse(list.payload).sessions as Array<{ id: string }>
    expect(listed.some((s) => s.id === sessionId)).toBe(false)
  }, 30000)

  test('non-global nonexistent sessions still 404', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/sessions/session_nonexistent/close',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('#bug2 doc-session isolation', () => {
  test('writing session (doc-*) never creates a Session row and never lists', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const sessionId = `doc-bug2_${Date.now()}`
    const { deepseekChat } = await import('../../src/common/llm.js')
    let calls = 0
    vi.mocked(deepseekChat).mockImplementation((messages: any) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      calls++
      return Promise.resolve('写作回复。')
    })

    await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '帮我校对文档', session_id: sessionId }),
    })

    // No Session row created for the writing session
    const row = await (prisma as any).session.findUnique({ where: { id: sessionId } })
    expect(row).toBeNull()

    // And it never appears in the session list
    const list = await app.inject({ method: 'GET', url: '/api/v1/sessions', headers: await authHeader() })
    const sessions = JSON.parse(list.payload).sessions
    expect(sessions.some((s: any) => s.id === sessionId)).toBe(false)
  }, 30000)
})
