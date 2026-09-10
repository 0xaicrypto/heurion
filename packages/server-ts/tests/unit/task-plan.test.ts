import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { SetTaskPlanTool, buildPlanUpdatedEvent } from '../../src/tools/set-task-plan-tool.js'
import { shouldRunDocExecutor, PLAN_RELAY_RE } from '../../src/modules/chat/doc-executor.js'
import { renderPlanBlock, planBacklog, renderPendingSteps } from '../../src/common/plan-store.js'
import { shouldInjectPlanRule } from '../../src/modules/chat/writing-prompts.js'
import { runToolCallLoop, type TurnIO } from '../../src/modules/chat/tool-loop.js'
import { ToolRegistry } from '../../src/tools/tool-registry.js'
import { BaseTool, type ToolResult } from '../../src/tools/base-tool.js'
import prisma from '../../src/common/prisma.js'
import type { ChatStreamChunk, TaskPlan } from '@heurion/contracts'

vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'

/**
 * #976 — 任务清单机制核心链路（agent todo-list 模式）：
 * 闸门 1（<3 步硬拒）、闸门 3（写回步骤系统自动推进/失败标注）、
 * 对账（planBacklog）、接力（PLAN_RELAY_RE）、注入稳定段。
 */

// 运行时构造 tool-call 文本协议标记(避免测试源码出现可执行协议明文)。
const LT = String.fromCharCode(60)
const callBlock = (json: string) => LT + 'tool_call' + '>' + json + LT + '/tool_call' + '>'

const makeCtx = (sessionId: string): any => ({
  userId: 'user_plan',
  sessionId,
  eventLog: { append: vi.fn(), query: () => [], count: () => 0 },
  memory: { graph: { getAllNodes: () => [] } },
  facts: { all: () => [] },
  episodes: { all: () => [] },
  skills: { all: () => [] },
  knowledge: { all: () => [] },
})

class WriteTool extends BaseTool {
  constructor(private fail: boolean) { super() }
  get name(): string { return 'edit_document' }
  get description(): string { return 'edit_document' }
  get parameters(): Record<string, unknown> { return { type: 'object', properties: {} } }
  async execute(): Promise<ToolResult> {
    return this.fail
      ? { success: false, error: 'anchor not found' }
      : { success: true, output: '{"body":"x","summary":"已写入"}' }
  }
}

function makeIO() {
  const chunks: ChatStreamChunk[] = []
  const io: TurnIO = { send: (c) => chunks.push(c), signal: new AbortController().signal }
  return { io, chunks }
}

const UNIQUE = () => `doc-plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

/** TaskPlan.user 外键 — 测试 userId 需真实存在（FK 约束）。 */
async function ensureUser(userId: string): Promise<void> {
  await (prisma as any).user.upsert({
    where: { id: userId },
    update: {},
    create: {
      id: userId,
      displayName: `plan_${userId}_${Date.now()}`,
      role: 'user',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  })
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.clearAllMocks())

describe('#969 闸门 1 — 步数硬闸（简单任务不建清单）', () => {
  test('create steps < 3 → 拒绝并引导直接执行', async () => {
    const tool = new SetTaskPlanTool({ userId: 'user_plan1', sessionId: UNIQUE() })
    const r = await tool.execute({ action: 'create', title: '两步任务', steps: [{ title: '步骤一' }, { title: '步骤二' }] })
    expect(r.success).toBe(false)
    expect(r.error).toContain('不足 3 步')
    expect(r.error).toContain('直接执行')
  })

  test('create steps ≥ 3 → 成功 + prisma 落库 + 接力提示', async () => {
    const sid = UNIQUE()
    await ensureUser('user_plan1')
    const tool = new SetTaskPlanTool({ userId: 'user_plan1', sessionId: sid })
    const r = await tool.execute({
      action: 'create', title: '三节填充',
      steps: [
        { title: '补全 Abstract', tool: 'edit_document' },
        { title: '写入 Methods', tool: 'edit_document' },
        { title: '撰写 Discussion', tool: 'edit_document' },
      ],
    })
    expect(r.success).toBe(true)
    const { plan, kind, summary } = JSON.parse(r.output as string)
    expect(plan.steps).toHaveLength(3)
    expect(plan.steps[0].tool).toBe('edit_document')
    expect(kind).toBe('created')
    expect(summary).toContain('立即开始第一项')

    const row = await (prisma as any).taskPlan.findFirst({ where: { sessionId: sid, status: 'active' } })
    expect(row?.title).toBe('三节填充')
  })
})

describe('#969 闸门 3 — 写回步骤系统推进（反编造）', () => {
  test('模型手动 advance 写回步骤 → 拒绝（由系统推进）', async () => {
    const sid = UNIQUE()
    await ensureUser('user_plan2')
    const tool = new SetTaskPlanTool({ userId: 'user_plan2', sessionId: sid })
    await tool.execute({ action: 'create', title: 'T', steps: [
      { title: 'A', tool: 'edit_document' }, { title: 'B' }, { title: 'C' },
    ] })
    const r = await tool.execute({ action: 'advance', step_index: 1 })
    expect(r.success).toBe(false)
    expect(r.error).toContain('系统在工具执行成功后自动推进')

    // 非 tool 步骤可手动 advance
    const ok = await tool.execute({ action: 'advance', step_index: 2, note: '分析完成' })
    expect(ok.success).toBe(true)
    const { plan } = JSON.parse(ok.output as string)
    expect(plan.steps[1].status).toBe('done')
  })

  test('tool-loop: edit_document 成功 → 系统自动推进 + plan_updated SSE (source: system)', async () => {
    const sid = UNIQUE()
    await ensureUser('user_plan3')
    const setup = new SetTaskPlanTool({ userId: 'user_plan3', sessionId: sid })
    await setup.execute({ action: 'create', title: 'T', steps: [
      { title: '写第一节', tool: 'edit_document' },
      { title: '写第二节', tool: 'edit_document' },
      { title: '汇总分析' },
    ] })

    await ensureUser('user_plan3')
    const ctx = makeCtx(sid)
    const registry = new ToolRegistry(ctx)
    registry.register(new WriteTool(false))

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"edit_document","arguments":{"old_text":"a","new_text":"x"}}'))
      .mockResolvedValueOnce('第一节已写入。')

    const { io, chunks } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '开始执行清单' }],
      toolRegistry: registry,
      tools: [],
      apiKey: 'k',
      io,
      ctx,
      userId: 'user_plan3',
      sessionId: sid,
    })

    const plans = chunks.filter((c) => c.type === 'plan_updated')
    expect(plans.length).toBeGreaterThan(0)
    const sys = plans.find((c) => (c as any).source === 'system')
    expect(sys).toBeTruthy()
    expect((sys as any).plan.steps[0].status).toBe('done')
    expect((sys as any).kind).toBe('advanced')

    // DB 状态同步
    const row = await (prisma as any).taskPlan.findFirst({ where: { sessionId: sid, status: 'active' } })
    const steps = JSON.parse(row.stepsJson)
    expect(steps[0].status).toBe('done')
    expect(steps[1].status).toBe('pending')
  })

  test('写回失败 → 系统标注 failed（重试计数）', async () => {
    const sid = UNIQUE()
    await ensureUser('user_plan4')
    const setup = new SetTaskPlanTool({ userId: 'user_plan4', sessionId: sid })
    await setup.execute({ action: 'create', title: 'T', steps: [
      { title: '写第一节', tool: 'edit_document' },
      { title: 'B' }, { title: 'C' },
    ] })

    await ensureUser('user_plan4')
    const ctx = makeCtx(sid)
    const registry = new ToolRegistry(ctx)
    registry.register(new WriteTool(true))

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"edit_document","arguments":{"old_text":"zzz","new_text":"x"}}'))
      .mockResolvedValueOnce('第一节写入失败。')

    const { io, chunks } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '执行' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_plan4', sessionId: sid,
    })

    const plans = chunks.filter((c) => c.type === 'plan_updated' && (c as any).kind === 'failed')
    expect(plans.length).toBeGreaterThan(0)
    const row = await (prisma as any).taskPlan.findFirst({ where: { sessionId: sid, status: 'active' } })
    const steps = JSON.parse(row.stepsJson)
    expect(steps[0].status).toBe('failed')
    expect(steps[0].failure_note).toContain('anchor not found')
  })

  test('#972 对账：backlog（pending+failed）> 0 + 收尾声称完成 → plan_backlog 警示', async () => {
    const sid = UNIQUE()
    await ensureUser('user_plan5')
    const setup = new SetTaskPlanTool({ userId: 'user_plan5', sessionId: sid })
    await setup.execute({ action: 'create', title: 'T', steps: [
      { title: '写第一节', tool: 'edit_document' },
      { title: '写第二节', tool: 'edit_document' },
      { title: '写第三节', tool: 'edit_document' },
    ] })
    // 第 1 步成功推进（模拟上一轮）
    await setup.execute({ action: 'advance', step_index: 1 }).catch(() => undefined)
    // advance 是写回步骤会被拒 → 用系统推进语义：直接置 DB？改用 retry/skip 不可行 —
    // 用 skipStep 不可达；这里以手动置库方式模拟第 1 步 done。
    const row = await (prisma as any).taskPlan.findFirst({ where: { sessionId: sid, status: 'active' } })
    const steps = JSON.parse(row.stepsJson)
    steps[0].status = 'done'
    await (prisma as any).taskPlan.update({ where: { id: row.id }, data: { stepsJson: JSON.stringify(steps) } })

    const ctx = makeCtx(sid)
    const registry = new ToolRegistry(ctx)
    registry.register(new WriteTool(true)) // 第 2 步失败

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"edit_document","arguments":{"old_text":"b","new_text":"x"}}'))
      .mockResolvedValueOnce('第 1/3 步已完成，其余已落实。')

    const { io, chunks } = makeIO()
    const result = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '继续' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_plan5', sessionId: sid,
    })

    expect(result.planBacklogCount).toBe(2)
    expect(result.unbackedClaimCount).toBe(2)
    expect(result.planPendingText).toContain('写第二节')

    const infos = chunks.filter((c) => c.type === 'context_info')
    expect(infos.some((c) => String((c as any).text).includes('任务清单仍有 2 步未完成'))).toBe(true)
  })

  test('收口校验：pending 未清 → complete 拒绝；skip 后放行', async () => {
    const sid = UNIQUE()
    await ensureUser('user_plan6')
    const tool = new SetTaskPlanTool({ userId: 'user_plan6', sessionId: sid })
    await tool.execute({ action: 'create', title: 'T', steps: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] })

    const bad = await tool.execute({ action: 'complete' })
    expect(bad.success).toBe(false)
    expect(bad.error).toContain('严禁把未执行步骤汇报为已完成')

    await tool.execute({ action: 'advance', step_index: 1 })
    await tool.execute({ action: 'skip', step_index: 2, note: '用户放弃' })
    await tool.execute({ action: 'advance', step_index: 3 })
    const ok = await tool.execute({ action: 'complete' })
    expect(ok.success).toBe(true)
  })

  test('重试预算：failed 步 retry ×2 后拒绝', async () => {
    const sid = UNIQUE()
    await ensureUser('user_plan7')
    const tool = new SetTaskPlanTool({ userId: 'user_plan7', sessionId: sid })
    await tool.execute({ action: 'create', title: 'T', steps: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] })
    await tool.execute({ action: 'fail', step_index: 1, note: 'err1' })
    const r1 = await tool.execute({ action: 'retry', step_index: 1 })
    expect(r1.success).toBe(true)
    await tool.execute({ action: 'fail', step_index: 1, note: 'err2' })
    const r2 = await tool.execute({ action: 'retry', step_index: 1 })
    expect(r2.success).toBe(true)
    await tool.execute({ action: 'fail', step_index: 1, note: 'err2' })
    const r3 = await tool.execute({ action: 'retry', step_index: 1 })
    expect(r3.success).toBe(false)
    expect(r3.error).toContain('已重试 2 次')
  })
})

describe('#973 接力触发（PLAN_RELAY_RE + planBacklogCount）', () => {
  test('PLAN_RELAY_RE 覆盖继续/接着/下一步/重试第 K 步', () => {
    for (const t of ['继续', '继续第三步', '接着做', '下一步', '重试第 3 步']) {
      expect(PLAN_RELAY_RE.test(t)).toBe(true)
    }
    expect(PLAN_RELAY_RE.test('帮我导出 docx')).toBe(false)
  })

  test('shouldRunDocExecutor:清单 pending + 继续语义 → 触发（即使无编辑意图词）', () => {
    expect(shouldRunDocExecutor({
      sessionId: 'doc-x1', userText: '继续', executedWriteTools: ['edit_document'],
      planBacklogCount: 3, relayIntent: true,
    })).toBe(true)
    expect(shouldRunDocExecutor({
      sessionId: 'doc-x1', userText: '谢谢', executedWriteTools: ['edit_document'],
      planBacklogCount: 3, relayIntent: false,
    })).toBe(false)
  })
})

describe('#971/#972 纯函数（renderPlanBlock/planBacklog/renderPendingSteps）', () => {
  const plan: TaskPlan = {
    plan_id: 'p1', session_id: 's1', title: 'T',
    steps: [
      { index: 1, title: 'Abstract', status: 'done' },
      { index: 2, title: 'Methods', status: 'done' },
      { index: 3, title: 'Results', status: 'pending', tool: 'edit_document' },
      { index: 4, title: 'Discussion', status: 'failed', failure_note: '检索未命中' },
    ],
    status: 'active',
  }
  test('planBacklog = pending + failed', () => {
    expect(planBacklog(plan)).toBe(2)
  })
  test('renderPlanBlock 含进度/勾选态/收口纪律', () => {
    const block = renderPlanBlock(plan)
    expect(block).toContain('第 2/4 步已完成')
    expect(block).toContain('[x] 1. Abstract')
    expect(block).toContain('[ ] 3. Results')
    expect(block).toContain('失败')
    expect(block).toContain('严禁声称已完成')
  })
  test('renderPendingSteps 只列未完成步骤', () => {
    const text = renderPendingSteps(plan)
    expect(text).toContain('3. Results')
    expect(text).toContain('4. Discussion')
    expect(text).not.toContain('1. Abstract')
  })
  test('buildPlanUpdatedEvent 进度口径', () => {
    const ev = buildPlanUpdatedEvent(plan, 'advanced', 'system')
    expect(ev.progress).toEqual({ done: 2, total: 4 })
    expect(ev.source).toBe('system')
  })
})
describe('#969 闸门 2 — PLAN_RULE 回合门控（简单回合不注入）', () => {
  test('多任务信号触发', () => {
    for (const t of ['把全文按章节逐节填充', '全部处理这三条意见', '一直处理到第 5 段', '分多步完成它']) {
      expect(shouldInjectPlanRule(t, false)).toBe(true)
    }
  })
  test('普通回合不注入（无活跃清单）', () => {
    for (const t of ['润色这一段', '把表格改成英文', '这句再自然一点', '你好']) {
      expect(shouldInjectPlanRule(t, false)).toBe(false)
    }
  })
  test('已有活跃清单 → 恒注入（跨轮纪律）', () => {
    expect(shouldInjectPlanRule('随便说点什么', true)).toBe(true)
  })
})
