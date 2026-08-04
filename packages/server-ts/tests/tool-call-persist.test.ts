import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getApp, authHeader } from './setup.js'
import { detectDoomLoop } from '../src/tools/doom-loop.js'

vi.mock('../src/common/llm.js', () => ({
  deepseekChat: vi.fn(),
  deepseekStream: vi.fn(),
  getApiKey: () => 'test-key',
  setLlmTelemetryService: vi.fn(),
  DEEPSEEK_CHAT_MODEL: 'deepseek-v4-flash',
  DEEPSEEK_PREMIUM_MODEL: 'deepseek-v4-pro',
}))

import { deepseekChat } from '../src/common/llm.js'

beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', 'test-key') })
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

/**
 * R3 — tool-call persistence（#102）。事件状态机 pending → running →
 * completed/error + tool_result；可回放；消息流结构兼容；doom-loop 检测。
 */
describe('R3 tool-call persistence', () => {
  function mockToolTurn(toolName: string, args: Record<string, unknown>, finalAnswer = '查询完成。') {
    const block = `<tool_call>${JSON.stringify({ name: toolName, arguments: args })}</tool_call>`
    let calls = 0
    vi.mocked(deepseekChat).mockImplementation((messages: any) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      calls++
      if (calls === 1) return Promise.resolve(block)
      return Promise.resolve(finalAnswer)
    })
  }

  async function sendChatWithTool(text: string, sessionId: string) {
    const app = await getApp()
    return app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text, session_id: sessionId }),
    })
  }

  async function toolEvents(sessionId: string) {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agent/tool-events?session_id=${sessionId}`,
      headers: await authHeader(),
    })
    return JSON.parse(res.payload).events
  }

  test('#1 调用前落 tool_call pending 事件', async () => {
    const sessionId = `r3_pending_${Date.now()}`
    mockToolTurn('search_node', { query: 'ZQ', patient_hash: 'patient_r3' })

    await sendChatWithTool('查一下 ZQ 的情况', sessionId)

    const events = await toolEvents(sessionId)
    const pending = events.filter((e: any) => e.type === 'tool_call' && e.metadata.status === 'pending')
    expect(pending.length).toBeGreaterThan(0)
    expect(pending[0].metadata.tool).toBe('search_node')
  }, 30000)

  test('#2 执行成功 → running/completed + tool_result 事件', async () => {
    const sessionId = `r3_ok_${Date.now()}`
    mockToolTurn('search_node', { query: 'ZQ', patient_hash: 'patient_r3' })

    await sendChatWithTool('查一下 ZQ 的情况', sessionId)

    const events = await toolEvents(sessionId)
    const statuses = events.filter((e: any) => e.type === 'tool_call').map((e: any) => e.metadata.status)
    expect(statuses).toContain('pending')
    expect(statuses).toContain('running')
    expect(statuses).toContain('completed')
    const results = events.filter((e: any) => e.type === 'tool_result')
    expect(results.length).toBeGreaterThan(0)
    expect(results[results.length - 1].metadata.success).toBe(true)
  }, 30000)

  test('#3 执行失败 → error 状态 + error 信息落库', async () => {
    const sessionId = `r3_err_${Date.now()}`
    mockToolTurn('nonexistent_tool', { query: 'x' })

    await sendChatWithTool('调用一个不存在的工具', sessionId)

    const events = await toolEvents(sessionId)
    const statuses = events.filter((e: any) => e.type === 'tool_call').map((e: any) => e.metadata.status)
    expect(statuses).toContain('error')
    const results = events.filter((e: any) => e.type === 'tool_result')
    expect(results[results.length - 1].metadata.success).toBe(false)
    expect(results[results.length - 1].metadata.error).toContain('Unknown tool')
  }, 30000)

  test('#4 按 session 可回放完整工具调用序列（seq 单调）', async () => {
    const sessionId = `r3_replay_${Date.now()}`
    mockToolTurn('search_node', { query: 'ZQ', patient_hash: 'patient_r3' })

    await sendChatWithTool('查一下 ZQ 的情况', sessionId)

    const events = await toolEvents(sessionId)
    const seqs = events
      .map((e: any) => e.metadata?.toolCallId ?? e.metadata?.seq)
      .filter((s: any) => typeof s === 'number')
    expect(seqs.length).toBeGreaterThan(0)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThanOrEqual(seqs[i - 1])
  }, 30000)

  test('#5 消息流结构兼容 — messages API 不含工具事件', async () => {
    const sessionId = `r3_msgs_${Date.now()}`
    mockToolTurn('search_node', { query: 'ZQ', patient_hash: 'patient_r3' })

    await sendChatWithTool('查一下 ZQ 的情况', sessionId)

    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agent/messages?session_id=${sessionId}`,
      headers: await authHeader(),
    })
    const body = JSON.parse(res.payload)
    expect(body.messages.some((m: any) => m.role === 'user')).toBe(true)
    expect(body.messages.some((m: any) => m.role === 'assistant')).toBe(true)
    expect(body.messages.every((m: any) => !m.content.startsWith('search_node('))).toBe(true)
  }, 30000)
})

describe('R3 doom-loop detection (unit)', () => {
  test('#6 同工具同参数连续 3 次 → true', () => {
    const history: Array<{ tool: string; argsKey: string }> = []
    expect(detectDoomLoop(history, 'search_node', { query: 'ZQ' })).toBe(false)
    expect(detectDoomLoop(history, 'search_node', { query: 'ZQ' })).toBe(false)
    expect(detectDoomLoop(history, 'search_node', { query: 'ZQ' })).toBe(true)
  })

  test('参数变化 / 工具变化不触发', () => {
    const h1: Array<{ tool: string; argsKey: string }> = []
    detectDoomLoop(h1, 'search_node', { query: 'ZQ' })
    detectDoomLoop(h1, 'search_node', { query: 'ZQ' })
    expect(detectDoomLoop(h1, 'search_node', { query: 'ZZ' })).toBe(false)

    const h2: Array<{ tool: string; argsKey: string }> = []
    detectDoomLoop(h2, 'search_node', { query: 'ZQ' })
    detectDoomLoop(h2, 'search_node', { query: 'ZQ' })
    expect(detectDoomLoop(h2, 'search_past_chats', { query: 'ZQ' })).toBe(false)
  })
})

describe('U3 context usage chunk', () => {
  test('chat SSE payload includes context_usage with budget percentages', async () => {
    const app = await getApp()
    const sessionId = `u3_${Date.now()}`
    let calls = 0
    vi.mocked(deepseekChat).mockImplementation((messages: any) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      calls++
      return Promise.resolve(calls === 1 ? '第一条回复。' : '后续回复。')
    })

    // 3 turns so history tokens accumulate
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/agent/chat',
        headers: { ...await authHeader(), 'content-type': 'application/json' },
        payload: JSON.stringify({ text: `第${i + 1}轮讨论患者情况`, session_id: sessionId }),
      })
      expect(res.statusCode).toBe(200)
      // SSE payload is a text stream of JSON lines
      expect(res.payload).toContain('"type":"context_usage"')
      expect(res.payload).toContain('"history_budget":')
      expect(res.payload).toContain('"will_compact":')
    }
  }, 30000)
})

describe('U3 context usage endpoint', () => {
  test('GET /api/v1/agent/context-usage returns budget fields for a session with history', async () => {
    const app = await getApp()
    const sessionId = `u3e_${Date.now()}`
    let calls = 0
    vi.mocked(deepseekChat).mockImplementation((messages: any) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      calls++
      return Promise.resolve(calls === 1 ? '回复。' : '再回复。')
    })

    for (let i = 0; i < 2; i++) {
      await app.inject({
        method: 'POST', url: '/api/v1/agent/chat',
        headers: { ...await authHeader(), 'content-type': 'application/json' },
        payload: JSON.stringify({ text: `第${i + 1}轮`, session_id: sessionId }),
      })
    }

    const res = await app.inject({
      method: 'GET', url: `/api/v1/agent/context-usage?session_id=${sessionId}`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.history_budget).toBeGreaterThan(0)
    expect(typeof body.history_tokens).toBe('number')
    expect(body.history_tokens).toBeGreaterThan(0)
    expect(typeof body.will_compact).toBe('boolean')
    expect(typeof body.history_turns).toBe('number')
  }, 30000)
})
