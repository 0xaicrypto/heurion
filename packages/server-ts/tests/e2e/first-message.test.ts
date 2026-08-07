import { describe, test, expect, vi, beforeAll, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader } from '../setup.js'
import prisma from '../../src/common/prisma.js'
vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'

/** 复现：新建会话后第一条消息 AI 必须回复。 */
beforeAll(() => {
  vi.mocked(deepseekChat).mockImplementation((messages: any) => {
    const text = JSON.stringify(messages)
    if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
    return Promise.resolve('第一条回复内容')
  })
})

afterEach(async () => {
  await (prisma as any).session.deleteMany({})
})

describe('first message in a new session replies (bug repro)', () => {
  test('POST /sessions → first chat message streams a final answer', async () => {
    const app = await getApp()
    const h = await authHeader()
    const hj = { ...h, 'content-type': 'application/json' }

    const created = await app.inject({
      method: 'POST', url: '/api/v1/sessions',
      headers: hj, payload: JSON.stringify({ title: '新会话', scope: 'global' }),
    })
    const sid = JSON.parse(created.payload).id

    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: hj,
      payload: JSON.stringify({ text: '你好', session_id: sid }),
    })
    expect(res.statusCode).toBe(200)
    const chunks = res.payload.split('\n')
      .filter((l: string) => l.startsWith('data: '))
      .map((l: string) => { try { return JSON.parse(l.slice('data: '.length)) } catch { return null } })
      .filter(Boolean)
    const finalText = chunks.filter((e: any) => e.type === 'final_answer_chunk').map((e: any) => e.text).join('')
    expect(finalText).toContain('第一条回复内容')
    expect(chunks.some((e: any) => e.type === 'turn_complete')).toBe(true)
  })

  test('second message in the same session also replies', async () => {
    const app = await getApp()
    const h = await authHeader()
    const hj = { ...h, 'content-type': 'application/json' }
    const sid = `msg2_${Date.now()}`

    await app.inject({ method: 'POST', url: '/api/v1/agent/chat', headers: hj, payload: JSON.stringify({ text: '第一条', session_id: sid }) })
    const res = await app.inject({ method: 'POST', url: '/api/v1/agent/chat', headers: hj, payload: JSON.stringify({ text: '第二条', session_id: sid }) })
    const chunks = res.payload.split('\n')
      .filter((l: string) => l.startsWith('data: '))
      .map((l: string) => { try { return JSON.parse(l.slice('data: '.length)) } catch { return null } })
      .filter(Boolean)
    const finalText = chunks.filter((e: any) => e.type === 'final_answer_chunk').map((e: any) => e.text).join('')
    expect(finalText).toContain('第一条回复内容')
  })
})

describe('session persists after refresh (bug repro)', () => {
  test('created session + first message still listed afterwards', async () => {
    const app = await getApp()
    const h = await authHeader()
    const hj = { ...h, 'content-type': 'application/json' }

    const created = await app.inject({
      method: 'POST', url: '/api/v1/sessions',
      headers: hj, payload: JSON.stringify({ title: '持久会话', scope: 'global' }),
    })
    const sid = JSON.parse(created.payload).id

    await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: hj, payload: JSON.stringify({ text: '你好', session_id: sid }),
    })

    // Simulate a refresh: fresh list query must contain the session.
    const list = await app.inject({ method: 'GET', url: '/api/v1/sessions?scope=global', headers: h })
    expect(list.statusCode).toBe(200)
    const sessions = JSON.parse(list.payload).sessions
    const found = sessions.find((s: any) => s.id === sid)
    expect(found).toBeDefined()
    expect(found.title).toBe('持久会话')
    expect(found.status).toBe('open')
    expect(found.message_count).toBeGreaterThanOrEqual(1)
  })
})

describe('doc-* session history is queryable (#297)', () => {
  test('writing chat messages survive a refresh (queryable by session_id)', async () => {
    const app = await getApp()
    const h = await authHeader()
    const hj = { ...h, 'content-type': 'application/json' }
    const docId = `doc_reload_${Date.now()}`

    const chat = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: hj,
      payload: JSON.stringify({ text: '请修改文档标题', session_id: docId }),
    })
    expect(chat.statusCode).toBe(200)

    // Simulate a page refresh: query the event log by session_id.
    const msgs = await app.inject({
      method: 'GET', url: `/api/v1/agent/messages?session_id=${docId}`,
      headers: h,
    })
    const body = JSON.parse(msgs.payload)
    expect(body.total).toBeGreaterThanOrEqual(2) // user + assistant
    expect(body.messages.some((m: any) => m.content.includes('请修改文档标题'))).toBe(true)
  })
})
