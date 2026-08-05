import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from './helpers/ai-mock.js'
import { getApp, authHeader, getAuthUserId } from './setup.js'
import { getUserContext } from '../src/modules/chat/user-context.js'
import { MemoryGraphGateway } from '../src/memory/memory-gateway.js'

vi.mock('../src/common/llm.js', () => mockAiProvider())

import { deepseekChat } from '../src/common/llm.js'

beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', 'test-key') })
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('approve pending fact via API', () => {
  test('confirm a MemoryProposal through the HTTP approval endpoint', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()

    // S1: no real-time extraction — create the pending proposal directly
    // through the gateway (the approval flow itself is what's under test).
    const ctx = getUserContext(userId)
    const gateway = new MemoryGraphGateway(userId, ctx.memory, ctx.facts, ctx.episodes, ctx.skills, ctx.knowledge)
    await gateway.propose({
      scopeType: 'global',
      kind: 'fact',
      content: '患者确诊肺癌',
      importance: 5,
      confidence: 'medium',
      reason: 'test seed',
    })

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
