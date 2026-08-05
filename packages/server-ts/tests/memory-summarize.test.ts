import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getApp, authHeader, getAuthUserId } from './setup.js'
import prisma from '../src/common/prisma.js'
import { getUserContext } from '../src/modules/chat/user-context.js'

vi.mock('../src/common/llm.js', () => ({
  deepseekChat: vi.fn(),
  deepseekStream: vi.fn(),
  getApiKey: () => 'test-key',
  setLlmTelemetryService: vi.fn(),
  DEEPSEEK_CHAT_MODEL: 'deepseek-v4-flash',
  DEEPSEEK_PREMIUM_MODEL: 'deepseek-v4-pro',
}))

import { deepseekChat } from '../src/common/llm.js'

const SUMMARY = `## Objective
评估患者 ZQ 发热原因

## 患者重要信息
ZQ, 58y M, 胸痛咳嗽 3 周

## 决策与理由
建议胸部 CT（理由：排除肺部感染/占位）

## 已完成
- 血常规已开

## 进行中
- 等待 CT 结果

## 阻塞
(none)

## 下一步
1. 安排胸部 CT

## 相关文件与检查
- 血常规报告`

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('session summarize → pending closure (#114)', () => {
  test('POST /api/v1/memorization/sessions/:id/summarize proposes an episode_summary', async () => {
    const app = await getApp()
    const sessionId = `summ_${Date.now()}`

    // Seed conversation events
    await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({
        text: 'ZQ 胸痛咳嗽 3 周，先做一个初步诊断',
        session_id: sessionId,
        patient_hash: undefined,
      }),
    }).catch(() => {})

    // Inject conversation events directly via the chat endpoint with mocked LLM
    vi.mocked(deepseekChat).mockImplementation((messages) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      if (text.includes('临床对话摘要器')) return Promise.resolve(SUMMARY)
      return Promise.resolve('初步诊断：建议胸部 CT 排除肺部感染。')
    })

    await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '继续分析', session_id: sessionId }),
    })

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/memorization/sessions/${sessionId}/summarize`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.summary).toContain('Objective')
    expect(body.proposals).toBe(0)

    // Summary updates the Session Memory (episodes) instead of a proposal
    const userId = await getAuthUserId()
    const ctx = getUserContext(userId)
    const episodes = ctx.episodes.all().find((e) => e.sessionId === sessionId)
    expect(episodes?.summary).toContain('患者重要信息')

    // No episode_summary proposal is enqueued anymore (content-scoped —
    // other suites may seed summary-kind rows for the shared test user)
    const summaries = await (prisma as any).memoryProposal.findMany({
      where: { kind: 'episode_summary', status: 'pending' },
    })
    expect(summaries.some((s: any) => s.content.includes('患者重要信息'))).toBe(false)
  }, 30000)

  test('summarize with no conversation events returns 400', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/memorization/sessions/nonexistent_xyz/summarize',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    })
    expect(res.statusCode).toBe(400)
    expect(res.payload).toContain('No conversation events')
  })
})
