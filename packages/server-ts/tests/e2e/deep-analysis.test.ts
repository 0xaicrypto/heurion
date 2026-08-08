import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader } from '../setup.js'
import prisma from '../../src/common/prisma.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

/**
 * #420: parallel deep analysis — multiple sub-agents run concurrently
 * (Promise.all), sessions persist, synthesis merges the results.
 */
describe('parallel deep analysis (#420)', () => {
  test('runs parallel sub-agents, persists sessions, and synthesizes', async () => {
    await (prisma as any).subAgentSession.deleteMany({})
    const app = await getApp()
    const h = { ...await authHeader(), 'content-type': 'application/json' }

    vi.mocked(deepseekChat).mockImplementation((messages: any[]) => {
      const text = messages.map((m: any) => m.content || '').join('\n')
      if (text.includes('Combine the following sub-agent findings')) {
        return Promise.resolve('综合结论：文献支持免疫治疗；统计显示 PFS 获益。')
      }
      if (text.includes('Review the medical literature')) {
        return Promise.resolve('SUBAGENT_SUMMARY: 3 篇 RCT 支持 ICI 用于 EGFR 突变患者')
      }
      if (text.includes('Analyze the patient context')) {
        return Promise.resolve('SUBAGENT_SUMMARY: 患者适合联合治疗，注意心脏毒性')
      }
      return Promise.resolve('SUBAGENT_SUMMARY: done')
    })

    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/deep-analysis',
      headers: h,
      payload: JSON.stringify({
        patient_hash: 'patient_p1',
        topics: ['literature', 'clinical'],
        question: 'EGFR 突变 NSCLC 用免疫治疗是否获益？',
      }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('subagent_started')
    expect(res.payload).toContain('subagent_done')
    expect(res.payload).toContain('literature')
    expect(res.payload).toContain('clinical')
    expect(res.payload).toContain('综合结论')

    // Sessions persisted.
    const sessions = await (prisma as any).subAgentSession.findMany({})
    expect(sessions.length).toBe(2)
    expect(sessions.map((s: any) => s.topic).sort()).toEqual(['clinical', 'literature'])
    expect(sessions.every((s: any) => s.status === 'done')).toBe(true)
    expect(sessions.every((s: any) => s.costTokens > 0)).toBe(true)

    // History endpoint.
    const history = await app.inject({ method: 'GET', url: '/api/v1/agent/subagent-sessions', headers: await authHeader() })
    expect(JSON.parse(history.payload).sessions.length).toBe(2)
  }, 30000)

  test('rejects empty topics and empty question', async () => {
    const app = await getApp()
    const h = { ...await authHeader(), 'content-type': 'application/json' }
    const noTopics = await app.inject({
      method: 'POST', url: '/api/v1/agent/deep-analysis',
      headers: h, payload: JSON.stringify({ topics: ['nope'], question: 'x' }),
    })
    expect(noTopics.statusCode).toBe(400)
    const noQ = await app.inject({
      method: 'POST', url: '/api/v1/agent/deep-analysis',
      headers: h, payload: JSON.stringify({ topics: ['literature'], question: '' }),
    })
    expect(noQ.statusCode).toBe(400)
  })

  test('a failing sub-agent is isolated — others still complete and synthesize', async () => {
    await (prisma as any).subAgentSession.deleteMany({})
    const app = await getApp()
    const h = { ...await authHeader(), 'content-type': 'application/json' }

    vi.mocked(deepseekChat).mockImplementation((messages: any[]) => {
      const text = messages.map((m: any) => m.content || '').join('\n')
      if (text.includes('Review the medical literature')) {
        return Promise.reject(new Error('literature service down'))
      }
      if (text.includes('Analyze the patient context')) {
        return Promise.resolve('SUBAGENT_SUMMARY: 临床建议完成')
      }
      if (text.includes('Combine the sub-agent findings')) {
        return Promise.resolve('汇总完成（部分子任务失败）')
      }
      return Promise.resolve('SUBAGENT_SUMMARY: done')
    })

    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/deep-analysis',
      headers: h, payload: JSON.stringify({ topics: ['literature', 'clinical'], question: 'q' }),
    })
    expect(res.statusCode).toBe(200)
    // Isolation: literature failed is reported, clinical still completed.
    expect(res.payload).toContain('"task":"literature","success":false')
    expect(res.payload).toContain('"task":"clinical","success":true')

    const sessions = await (prisma as any).subAgentSession.findMany({})
    const failed = sessions.find((s: any) => s.topic === 'literature')
    const okOne = sessions.find((s: any) => s.topic === 'clinical')
    expect(failed.status).toBe('failed')
    expect(okOne.status).toBe('done')
  }, 30000)
})
