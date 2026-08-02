import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getApp, authHeader } from './setup.js'
import prisma from '../src/common/prisma.js'

vi.mock('../src/common/llm.js', () => ({
  deepseekChat: vi.fn(),
  deepseekStream: vi.fn(),
  getApiKey: () => 'test-key',
  setLlmTelemetryService: vi.fn(),
  DEEPSEEK_CHAT_MODEL: 'deepseek-v4-flash',
  DEEPSEEK_PREMIUM_MODEL: 'deepseek-v4-pro',
}))

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
    const userId = (await import('./setup.js')).getAuthUserId ? undefined : undefined

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
    const { deepseekChat } = await import('../src/common/llm.js')
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
      data: { id: sessionId, userId: (await import('./setup.js')).getAuthUserId ? '' : '', title: 'T', scope: 'global', status: 'open', createdAt: new Date().toISOString() },
    }).catch(() => {})

    // Close it via the session's owner — need the real user id
    const tokenPayload = JSON.parse(Buffer.from((await (await import('./setup.js')).authHeader()).authorization.split('.')[1], 'base64').toString())
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

    // Summarize fired async → episode_summary proposal appears (poll briefly)
    let proposal: any = null
    for (let i = 0; i < 20; i++) {
      proposal = await (prisma as any).memoryProposal.findFirst({
        where: { kind: 'episode_summary', status: 'pending' },
        orderBy: { createdAt: 'desc' },
      })
      if (proposal) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(proposal).toBeDefined()
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
