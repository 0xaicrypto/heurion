import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  clusterKey,
  evaluateCluster,
  buildInductionSummary,
  induceSkillsFromTrajectories,
  INDUCTION_DEFAULTS,
} from '../../src/modules/skills/trajectory-induction.service.js'
import { recordTaskTrajectory, TaskTrajectoryProjection, type TaskTrajectory } from '../../src/evolution/trajectory.js'
import { confirmApproval } from '../../src/modules/approvals/approval.service.js'
import { getUserContext } from '../../src/modules/shared/user-context.js'
import prisma from '../../src/common/prisma.js'

/**
 * #844 环② — 轨迹归纳器:
 * 阈值(4 条不触发/5 条触发)/ 证据链可反查 / 归纳输入零正文 /
 * 候选走闸门(kind='skill'),审批通过落图 SkillNode。
 */

// LLM 归纳 — partial mock:deepseekChat 返回 STRICT JSON(零外呼),其余导出保真
vi.mock('../../src/common/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/common/llm.js')>()
  return {
    ...actual,
    getApiKey: () => 'test-key',
    deepseekChat: vi.fn(async () => JSON.stringify({
      name: '文献写作流程',
      description: '检索→核对→写入 References 的固定流程',
      steps: ['search_citation 检索主题', '核对 PMID/DOI', '写入 References 并保留检索键'],
      promptTemplate: '新增引用前先检索真实文献,零编造。',
      triggers: ['references', '引用', '文献'],
    })),
  }
})

function fakeCluster(n: number, spanDays = 20, correctionEvery = 0): Array<Partial<TaskTrajectory>> {
  const now = Date.now()
  const dayMs = 24 * 3600 * 1000
  return Array.from({ length: n }, (_, i) => ({
    action: 'generate' as const,
    scene: 'document',
    toolsUsed: ['edit_document', 'render_chart'],
    docEdits: 2,
    outcome: 'completed' as const,
    userCorrection: correctionEvery > 0 && i % correctionEvery === 0,
    durationMs: 60_000,
    // 总跨度 ≈ spanDays:i=0 最旧,i=n-1 最新
    createdAt: now - Math.round((spanDays * dayMs) * (n - 1 - i) / Math.max(n - 1, 1)),
    id: `trj_fake_${i}`,
    sessionId: `s_${Math.floor(i / 3)}`,
    userId: 'u',
    turnId: i,
  }))
}

describe('聚类与阈值(验收:4 条不触发,5 条触发)', () => {
  test('同 taskKind+同工具序列 → 同簇;不同序列 → 不同簇', () => {
    expect(clusterKey({ action: 'generate', toolsUsed: ['a', 'b'] }))
      .toBe(clusterKey({ action: 'generate', toolsUsed: ['a', 'b'] }))
    expect(clusterKey({ action: 'generate', toolsUsed: ['a', 'b'] }))
      .not.toBe(clusterKey({ action: 'generate', toolsUsed: ['b', 'a'] }))
    expect(clusterKey({ action: 'edit', toolsUsed: ['a', 'b'] }))
      .not.toBe(clusterKey({ action: 'generate', toolsUsed: ['a', 'b'] }))
  })

  test('4 条轨迹不触发;5 条触发(跨度/修正率达标时)', () => {
    const four = evaluateCluster(fakeCluster(4))
    expect(four.eligible).toBe(false)
    expect(four.reasons[0]).toContain('观察不足')

    const five = evaluateCluster(fakeCluster(5))
    expect(five.eligible).toBe(true)
    expect(five.observationCount).toBe(5)
  })

  test('时间跨度 14 天与修正率 0.3 阈值独立生效', () => {
    const shortSpan = evaluateCluster(fakeCluster(5, 10))
    expect(shortSpan.eligible).toBe(false)
    expect(shortSpan.reasons.some((r) => r.includes('时间跨度'))).toBe(true)

    const highCorrection = evaluateCluster(fakeCluster(5, 20, 2)) // 3/5 修正
    expect(highCorrection.eligible).toBe(false)
    expect(highCorrection.reasons.some((r) => r.includes('修正率'))).toBe(true)
  })
})

describe('归纳输入零正文(验收:输入构造审查)', () => {
  test('buildInductionSummary 只含操作元数据,不含 query/文档内容', () => {
    const cluster = fakeCluster(5) as TaskTrajectory[]
    const summary = buildInductionSummary(cluster)
    // 工具序列在,场景在
    expect(summary).toContain('edit_document')
    expect(summary).toContain('document')
    // 结构性保证:输入只有白名单字段 — 无内容字段可渲染
    for (const t of cluster) {
      expect(Object.keys(t)).not.toContain('query')
      expect(Object.keys(t)).not.toContain('content')
    }
  })
})

describe('端到端:轨迹 → 聚类 → LLM → 提案闸门 → 审批落图', () => {
  beforeEach(async () => {
    await (prisma as any).memoryProposal.deleteMany({})
    await (prisma as any).approvalRequest.deleteMany({})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 每测试独立用户 — eventLog/轨迹按用户隔离,避免共享累积串簇 */
  async function freshUser(): Promise<{ userId: string; ctx: ReturnType<typeof getUserContext> }> {
    const { getApp } = await import('../setup.js')
    const app = await getApp()
    const username = `ind_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const register = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username, password: 'test123456', display_name: `Induction ${Math.random().toString(36).slice(2, 8)}` },
    })
    if (register.statusCode !== 200) console.error('[freshUser] register failed:', register.statusCode, register.payload.slice(0, 400))
    expect(register.statusCode).toBe(200)
    const token = JSON.parse(register.payload).jwt_token
    const userId = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).userId
    return { userId, ctx: getUserContext(userId) }
  }
  test('达标聚类产 skill 提案,证据链可反查真实轨迹;审批通过落 SkillNode', async () => {
    const { userId, ctx } = await freshUser()
    const log = ctx.eventLog

    // 5 条真实轨迹:同会话内连续记录,时间跨度通过直接改写 createdAt 达标不可行
    // (eventLog 追加) — 归纳器的跨度阈值在测试中放宽到 0 天,阈值逻辑已单测覆盖。
    for (let i = 0; i < 5; i++) {
      log.append({ timestamp: Date.now() / 1000 - (20 * 24 * 3600 - i), eventType: 'user_message', content: `turn ${i}`, metadata: {}, agentId: userId, sessionId: 's_ind' })
      recordTaskTrajectory(log, {
        userId, sessionId: 's_ind', action: 'generate', scene: 'document',
        toolsUsed: ['edit_document', 'render_chart'], docEdits: 2, outcome: 'completed',
      })
    }

    const result = await induceSkillsFromTrajectories(userId, { minSpanDays: 0, maxCorrectionRate: 1 })
    expect(result.proposed).toBe(1)
    const detail = result.details.find((d) => d.proposalId)
    expect(detail?.proposalId).toBeTruthy()

    // 提案行:kind=skill + payload 证据链
    const row = await (prisma as any).memoryProposal.findUnique({ where: { id: detail!.proposalId } })
    expect(row.kind).toBe('skill')
    expect(row.status).toBe('pending')
    const payload = JSON.parse(row.payload)
    const projection = new TaskTrajectoryProjection(log)
    const realIds = new Set(projection.query().map((t) => t.id))
    // 证据链可反查:trajectoryIds 都是投影里的真实轨迹 id
    expect(payload.skill.evidence.trajectoryIds.length).toBeGreaterThanOrEqual(5)
    for (const tid of payload.skill.evidence.trajectoryIds) {
      expect(realIds.has(tid)).toBe(true)
    }
    expect(payload.skill.evidence.sessionIds).toContain('s_ind')
    expect(payload.skill.source).toBe('synthesis')
    expect(payload.skill.taskKind).toBe('generate')

    // 审批通过 → SkillNode 落图(v2 契约)
    const req = await (prisma as any).approvalRequest.findFirst({ where: { targetType: 'MemoryProposal', targetId: row.id } })
    await confirmApproval(userId, req.id)
    const approved = await (prisma as any).memoryProposal.findUnique({ where: { id: row.id } })
    expect(approved.status).toBe('approved')

    const node: any = ctx.memory.graph.getNodesByType('skill').find((n) => n.name === '文献写作流程')
    expect(node).toBeTruthy()
    expect(node.steps.length).toBe(3)
    expect(node.promptTemplate).toContain('零编造')
    expect(node.scope).toBe('personal')
    expect(node.evidence.trajectoryIds.length).toBeGreaterThanOrEqual(5)
    expect(node.lifecycle).toBe('active')
  })

  test('PII 候选在闸门被拒:候选带患者姓名/住院号时不产生待审行', async () => {
    const { userId, ctx } = await freshUser()
    const induction = (await import('../../src/modules/skills/trajectory-induction.service.js')) as unknown as typeof import('../../src/modules/skills/trajectory-induction.service.js')

    for (let i = 0; i < 5; i++) {
      recordTaskTrajectory(ctx.eventLog, {
        userId, sessionId: 's_pii', action: 'generate', scene: 'document',
        toolsUsed: ['edit_document'], docEdits: 1, outcome: 'completed',
      })
    }
    const llm = await import('../../src/common/llm.js')
    vi.mocked(llm.deepseekChat).mockResolvedValueOnce(JSON.stringify({
      name: '小结流程',
      description: '生成出院小结',
      steps: ['填写住院号 2025088123'],
      promptTemplate: '为患者王芳生成小结',
      triggers: ['小结'],
    }))

    const result = await induction.induceSkillsFromTrajectories(userId, { minSpanDays: 0, maxCorrectionRate: 1 })
    expect(result.piiRejected).toBeGreaterThanOrEqual(1)
    // 不产生 skill 待审提案(提案行内容无 '小结流程')
    const rows = await (prisma as any).memoryProposal.findMany({ where: { userId, kind: 'skill' } })
    expect(rows.some((r: any) => String(r.content).includes('小结流程'))).toBe(false)
  })

  test('不达标聚类零提案、零 LLM 调用', async () => {
    const { userId, ctx } = await freshUser()
    const llm = await import('../../src/common/llm.js')
    const callsBefore = vi.mocked(llm.deepseekChat).mock.calls.length

    // 独立工具序列指纹 — 共享用户 eventLog 跨测试累积,不同指纹互不串簇
    for (let i = 0; i < 4; i++) {
      recordTaskTrajectory(ctx.eventLog, {
        userId, sessionId: 's_thin', action: 'generate', scene: 'document',
        toolsUsed: ['unique_thin_tool'], docEdits: 1, outcome: 'completed',
      })
    }
    const result = await induceSkillsFromTrajectories(userId, { minSpanDays: 0, maxCorrectionRate: 1 })
    expect(result.proposed).toBe(0)
    expect(result.details[0]?.reasons?.[0]).toContain('观察不足')
    expect(vi.mocked(llm.deepseekChat).mock.calls.length).toBe(callsBefore)
    expect(INDUCTION_DEFAULTS.minObservations).toBe(5)
  })
})
