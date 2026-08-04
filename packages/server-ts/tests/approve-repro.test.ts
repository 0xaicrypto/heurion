import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getApp, authHeader } from './setup.js'

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

describe('approve pending fact via API', () => {
  test('confirm a MemoryProposal through the HTTP approval endpoint', async () => {
    const app = await getApp()
    const sessionId = `apr_${Date.now()}`

    vi.mocked(deepseekChat).mockImplementation((messages) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      if (text.includes('clinical memory extractor')) {
        return Promise.resolve('[{"category":"diagnosis","importance":5,"content":"患者确诊肺癌","sourceType":"patient"}]')
      }
      if (text.includes('临床对话摘要器')) return Promise.resolve('## Objective\nx')
      return Promise.resolve('ok')
    })

    // Seed a conversation with a signal → extraction proposes a fact
    await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '患者确诊肺癌，请记住这个诊断结果并记录', session_id: sessionId }),
    })
    await new Promise((r) => setTimeout(r, 3200))

    const pending = await app.inject({
      method: 'GET', url: '/api/v1/approvals/pending',
      headers: await authHeader(),
    })
    const { requests } = JSON.parse(pending.payload)
    const proposalReq = requests.find((r: any) => r.targetType === 'MemoryProposal')
    expect(proposalReq).toBeTruthy()

    const confirm = await app.inject({
      method: 'POST', url: `/api/v1/approvals/${proposalReq.id}/confirm`,
      headers: await authHeader(),
    })
    expect(confirm.statusCode).toBe(200)
    const body = JSON.parse(confirm.payload)
    expect(body.status).toBe('approved')
  }, 30000)
})
