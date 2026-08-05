import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from './helpers/ai-mock.js'
import { getApp, authHeader, getAuthUserId } from './setup.js'
import prisma from '../src/common/prisma.js'
import { getUserContext } from '../src/modules/chat/user-context.js'
import { PrismaKnowledgeGapService } from '../src/modules/knowledge/knowledge-gap.service.js'

vi.mock('../src/common/llm.js', () => mockAiProvider())

beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', 'test-key') })
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

/**
 * K6 — Gap 自动检测（#111）。
 * 条件：用户消息为问题形态（?/？/如何/是否/为什么）且未被 facts 覆盖；
 * 去重：同文本 7 天内不重复创建；失败不影响主流程。
 */
describe('K6 gap auto-detection', () => {
  async function sendChat(text: string, sessionId: string) {
    const app = await getApp()
    return app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text, session_id: sessionId }),
    })
  }

  async function freshUserId(): Promise<string> {
    // Register a real user so the knowledge_gaps FK is satisfied, while
    // keeping each test's memory + gaps fully isolated.
    const app = await getApp()
    const username = `k6_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username, password: 'test123456', display_name: 'K6 Tester' }),
    })
    const body = JSON.parse(res.payload)
    const payload = JSON.parse(Buffer.from(body.jwt_token.split('.')[1], 'base64').toString())
    return payload.userId
  }

  async function postTurnDirect(userId: string, sessionId: string, message: string) {
    // Direct orchestrator call with an isolated user — no HTTP queue timing,
    // no cross-test facts pollution (each user has its own disk-backed memory).
    const ctx = getUserContext(userId)
    await ctx.orchestrator.postTurn(userId, sessionId, message)
  }

  test('#4 问题形态消息且未被覆盖 → 自动创建 gap', async () => {
    const userId = await freshUserId()
    const sessionId = `k6_q_sess_${Date.now()}`

    await postTurnDirect(userId, sessionId, '患者为什么持续发热？')

    const gaps = await (prisma as any).knowledgeGap.findMany({ where: { userId, status: 'open' } })
    expect(gaps.some((g: any) => g.content.includes('持续发热'))).toBe(true)
  }, 30000)

  test('#5 非问题形态消息 → 不创建 gap', async () => {
    const userId = await freshUserId()
    const sessionId = `k6_stmt_sess_${Date.now()}`

    await postTurnDirect(userId, sessionId, '患者发热三天，记录一下这个症状')

    const gaps = await (prisma as any).knowledgeGap.findMany({ where: { userId, status: 'open' } })
    expect(gaps.filter((g: any) => g.source === 'chat')).toHaveLength(0)
  }, 30000)

  test('#6 问题已被 facts 覆盖 → 不创建 gap', async () => {
    const userId = await freshUserId()
    const sessionId = `k6_covered_sess_${Date.now()}`

    // Seed a fact that covers the question's keywords
    const ctx = getUserContext(userId)
    ctx.memory.addFact(
      { content: '患者发热持续3周伴胸痛，考虑肺部感染', category: 'diagnosis', importance: 4, patientHash: undefined, sourceType: 'patient' },
      'system',
    )

    await postTurnDirect(userId, sessionId, '发热的原因是什么？')

    const gaps = await (prisma as any).knowledgeGap.findMany({ where: { userId, status: 'open' } })
    expect(gaps.filter((g: any) => g.source === 'chat')).toHaveLength(0)
  }, 30000)

  test('#7 同文本 7 天内重复 → 不重复创建（service 去重）', async () => {
    const userId = await getAuthUserId()
    const service = new PrismaKnowledgeGapService()

    await service.create({ userId, workspaceId: userId, content: 'PD-L1 表达水平如何解读？', source: 'chat' })
    await service.create({ userId, workspaceId: userId, content: 'PD-L1 表达水平如何解读？', source: 'chat' })
    await service.create({ userId, workspaceId: userId, content: '  PDL1表达水平如何解读 ？', source: 'chat' })

    const gaps = await (prisma as any).knowledgeGap.findMany({
      where: { userId, content: { contains: 'PD' } },
    })
    expect(gaps.length).toBe(1)

    await service.create({ userId, workspaceId: userId, content: 'ALK 突变如何检测？', source: 'chat' })
    const after = await (prisma as any).knowledgeGap.findMany({ where: { userId, status: 'open' } })
    expect(after.length).toBe(2)
  }, 30000)
})
