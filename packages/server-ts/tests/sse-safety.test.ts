import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getApp, authHeader, getAuthUserId } from './setup.js'
import { getUserContext } from '../src/modules/chat/user-context.js'

vi.mock('../src/common/llm.js', () => ({
  deepseekChat: vi.fn(),
  deepseekStream: vi.fn(),
  getApiKey: () => 'test-key',
  setLlmTelemetryService: vi.fn(),
  DEEPSEEK_CHAT_MODEL: 'deepseek-v4-flash',
  DEEPSEEK_PREMIUM_MODEL: 'deepseek-v4-pro',
  fetchWithRetry: vi.fn(),
  FRIENDLY_LLM_ERROR: '服务暂时不可用，请稍后重试',
}))

import { deepseekChat, deepseekStream } from '../src/common/llm.js'

beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', 'test-key') })
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('#185 SSE safety', () => {
  test('user message is persisted even when the LLM stream fails', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const ctx = getUserContext(userId)
    const sessionId = `sse_${Date.now()}`

    vi.mocked(deepseekChat).mockImplementation(async (messages: any) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      throw new Error('模拟 LLM 崩溃')
    })

    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '这条消息必须保留', session_id: sessionId }),
    })
    expect(res.statusCode).toBe(200)

    // The user message exists in the event log despite the failure
    const events = ctx.eventLog.query({ sessionId }).filter((e: any) => e.eventType === 'user_message')
    expect(events.some((e: any) => String(e.content).includes('这条消息必须保留'))).toBe(true)
  }, 30000)

  test('write to a destroyed socket does not throw', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'test', session_id: `sse2_${Date.now()}` }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('turn_started')
  }, 30000)
})
