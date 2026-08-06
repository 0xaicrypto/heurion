import { describe, test, expect, vi, beforeAll } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader } from '../setup.js'
import prisma from '../../src/common/prisma.js'
vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'

/**
 * 边界审计（#252）：查询参数缺失时绝不能退回"全量返回"——
 * EventLog.query(undefined) 之前会泄漏所有会话的数据（#251 同源）。
 * 本文件锁定：messages / tool-events / context-usage / sessions。
 */
beforeAll(() => {
  vi.mocked(deepseekChat).mockResolvedValue('ok')
})

async function seedSession(app: any, token: any, sessionId: string) {
  // A chat turn creates user+assistant events in that session.
  await app.inject({
    method: 'POST', url: '/api/v1/agent/chat',
    headers: { ...token, 'content-type': 'application/json' },
    payload: JSON.stringify({ text: `hello ${sessionId}`, session_id: sessionId }),
  })
}

describe('missing session_id never leaks other sessions (边界 #252)', () => {
  test('messages without session_id → empty', async () => {
    const app = await getApp()
    const token = await authHeader()
    await seedSession(app, token, 'boundary_msg_s1')
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agent/messages',
      headers: token,
    })
    const body = JSON.parse(res.payload)
    expect(body.messages).toEqual([])
    expect(body.total).toBe(0)
  })

  test('tool-events without session_id → empty (was: every session)', async () => {
    const app = await getApp()
    const token = await authHeader()
    await seedSession(app, token, 'boundary_tool_s1')
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agent/tool-events',
      headers: token,
    })
    const body = JSON.parse(res.payload)
    expect(body.events).toEqual([])
    expect(body.total).toBe(0)
  })

  test('context-usage without session_id → zeroed budget (was: cross-session aggregate)', async () => {
    const app = await getApp()
    const token = await authHeader()
    await seedSession(app, token, 'boundary_ctx_s1')
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agent/context-usage',
      headers: token,
    })
    const body = JSON.parse(res.payload)
    expect(body.history_tokens).toBe(0)
    expect(body.omitted_turns).toBe(0)
    expect(body.will_compact).toBe(false)
  })

  test('sessions list is always user-scoped and never auto-creates', async () => {
    const app = await getApp()
    const token = await authHeader()
    const res = await app.inject({ method: 'GET', url: '/api/v1/sessions', headers: token })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(Array.isArray(body.sessions)).toBe(true)
    expect(body.sessions.every((s: any) => !String(s.id).startsWith('global-'))).toBe(true)
  })
})

describe('required params still 400 (边界 #252)', () => {
  test('chat without text → 400', async () => {
    const app = await getApp()
    const token = await authHeader()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...token, 'content-type': 'application/json' },
      payload: JSON.stringify({ session_id: 'boundary_req' }),
    })
    expect(res.statusCode).toBe(400)
  })

  test('sessions POST with empty title → default title, still 200', async () => {
    const app = await getApp()
    const token = await authHeader()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/sessions',
      headers: { ...token, 'content-type': 'application/json' },
      payload: JSON.stringify({ title: '', scope: 'global' }),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.title).toBeTruthy()
    expect(body.id.startsWith('global-')).toBe(false)
    // cleanup
    await prisma.session.deleteMany({ where: { id: body.id } })
  })
})
