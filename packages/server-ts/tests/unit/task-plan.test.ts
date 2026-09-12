import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { SetTaskPlanTool, buildPlanUpdatedEvent } from '../../src/tools/set-task-plan-tool.js'
import { shouldRunDocExecutor, PLAN_RELAY_RE } from '../../src/modules/chat/doc-executor.js'
import { renderPlanBlock, planBacklog, renderPendingSteps } from '../../src/common/plan-store.js'
import { PLAN_RULE } from '../../src/modules/chat/writing-prompts.js'
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

class ProbeTool extends BaseTool {
  constructor(private run: () => Promise<ToolResult>) { super() }
  get name(): string { return 'probe' }
  get description(): string { return 'probe' }
  get parameters(): Record<string, unknown> { return { type: 'object', properties: {} } }
  async execute(): Promise<ToolResult> { return this.run() }
}

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

beforeEach(() => { vi.clearAllMocks(); vi.mocked(deepseekChat).mockReset() })
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

  test('#989 步骤×节对账:section 随步骤展示(节 [sec:...])', () => {
    const withSection: TaskPlan = {
      plan_id: 'p2', session_id: 's2', title: 'T',
      steps: [
        { index: 1, title: 'Abstract', status: 'pending', tool: 'edit_document', section: 's_abc123456789' },
        { index: 2, title: 'Methods', status: 'pending', tool: 'edit_document' },
      ],
      status: 'active',
    }
    const block = renderPlanBlock(withSection)
    expect(block).toContain('1. Abstract（节 [sec:s_abc123456789]）')
    // 无 section 的步骤不展示
    expect(block).not.toContain('Methods（节')
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
describe('#969 闸门 2 修正（#979 复盘）— PLAN_RULE 常驻,意图判断归模型', () => {
  test('PLAN_RULE 存在且含判断边界（≥3 步建清单 / 1-2 步直接执行）', () => {
    expect(PLAN_RULE).toContain('≥3 个独立步骤')
    expect(PLAN_RULE).toContain('禁止建清单')
    expect(PLAN_RULE).toContain('账本')
  })
})
describe('#979 意图推断 — 无 action 字段时从参数推断', () => {
  test('steps 数组在、action 缺 → 按 create 处理', async () => {
    const sid = UNIQUE()
    await ensureUser('user_plan8')
    const tool = new SetTaskPlanTool({ userId: 'user_plan8', sessionId: sid })
    const r = await tool.execute({ steps: [{ title: 'A', tool: 'edit_document' }, { title: 'B', tool: 'edit_document' }, { title: 'C' }] })
    expect(r.success).toBe(true)
    const { plan } = JSON.parse(r.output as string)
    expect(plan.steps).toHaveLength(3)
  })

  test('step_index 在、action 缺失 → 按 advance 处理', async () => {
    const sid = UNIQUE()
    await ensureUser('user_plan9')
    const tool = new SetTaskPlanTool({ userId: 'user_plan9', sessionId: sid })
    await tool.execute({ action: 'create', title: 'T', steps: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] })
    const r = await tool.execute({ step_index: 2 })
    expect(r.success).toBe(true)
    const { plan } = JSON.parse(r.output as string)
    expect(plan.steps[1].status).toBe('done')
  })
})
describe('#976 收尾空转守卫 + 开始接力（重试回合生产实例）', () => {
  test('backlog > 0 且本轮零写回（收尾是等待确认话术）→ 无条件警示', async () => {
    const sid = UNIQUE()
    await ensureUser('user_plan10')
    const setup = new SetTaskPlanTool({ userId: 'user_plan10', sessionId: sid })
    await setup.execute({ action: 'create', title: 'T', steps: [
      { title: '写第一节', tool: 'edit_document' },
      { title: '写第二节', tool: 'edit_document' },
      { title: '写第三节', tool: 'edit_document' },
    ] })

    const ctx = makeCtx(sid)
    const registry = new ToolRegistry(ctx)
    // 只读工具（模拟模型建完清单后输出了读操作而非写回）
    const readProbe = new ProbeTool(() => Promise.resolve({ success: true, output: '{"hits":[]}' }))
    Object.defineProperty(readProbe, 'name', { value: 'search_past_chats' })
    registry.register(readProbe)

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"search_past_chats","arguments":{}}'))
      .mockResolvedValueOnce('清单已建立，回复「开始」我就逐项真实写回。')

    const { io, chunks } = makeIO()
    const result = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '开始' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_plan10', sessionId: sid,
    })

    expect(result.planBacklogCount).toBe(3)
    expect(result.unbackedClaimCount).toBe(3)
    const infos = chunks.filter((c) => c.type === 'context_info')
    expect(infos.some((c) => String((c as any).text).includes('尚未执行任何写回'))).toBe(true)
  })

  test('PLAN_RELAY_RE 认「开始」（确认信号）', () => {
    expect(PLAN_RELAY_RE.test('开始')).toBe(true)
    expect(PLAN_RELAY_RE.test('开始吧')).toBe(true)
  })
})
describe('#982 step_index 精确推进 — 乱序编辑不再记错账', () => {
  test('乱序调用(先 step_index 3 再 1)→ 各自正确勾选,FIFO 不顶替', async () => {
    const sid = UNIQUE()
    await ensureUser('user_plan14')
    const setup = new SetTaskPlanTool({ userId: 'user_plan14', sessionId: sid })
    await setup.execute({ action: 'create', title: 'T', steps: [
      { title: '写第一节', tool: 'edit_document' },
      { title: '写第二节', tool: 'edit_document' },
      { title: '写第三节', tool: 'edit_document' },
    ] })

    await ensureUser('user_plan14')
    const ctx = makeCtx(sid)
    const registry = new ToolRegistry(ctx)
    registry.register(new WriteTool(false))

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"edit_document","arguments":{"old_text":"c","new_text":"x","step_index":3}}'))
      .mockResolvedValueOnce(callBlock('{"name":"edit_document","arguments":{"old_text":"a","new_text":"y","step_index":1}}'))
      .mockResolvedValueOnce('第 3、1 步已完成。')

    const { io, chunks } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '乱序执行' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_plan14', sessionId: sid,
    })

    const row = await (prisma as any).taskPlan.findFirst({ where: { sessionId: sid, status: 'active' } })
    const steps = JSON.parse(row.stepsJson)
    // 各自归位:第 3、1 步 done,第 2 步 pending(旧 FIFO 会把第 3 步的完成记到第 1 步)
    expect(steps[2].status).toBe('done')
    expect(steps[0].status).toBe('done')
    expect(steps[1].status).toBe('pending')

    // SSE 侧:两次 system 推进均发出
    const sys = chunks.filter((c) => c.type === 'plan_updated' && (c as any).source === 'system')
    expect(sys.length).toBe(2)
  })

  test('step_index 指向不存在/非 pending 步骤 → 不推进(精确匹配不误跳)', async () => {
    const sid = UNIQUE()
    await ensureUser('user_plan15')
    const setup = new SetTaskPlanTool({ userId: 'user_plan15', sessionId: sid })
    await setup.execute({ action: 'create', title: 'T', steps: [
      { title: 'A', tool: 'edit_document' }, { title: 'B' }, { title: 'C' },
    ] })

    const ctx = makeCtx(sid)
    const registry = new ToolRegistry(ctx)
    registry.register(new WriteTool(false))

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"edit_document","arguments":{"old_text":"a","new_text":"x","step_index":9}}'))
      .mockResolvedValueOnce('done')

    const { io, chunks } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '执行' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_plan15', sessionId: sid,
    })

    const row = await (prisma as any).taskPlan.findFirst({ where: { sessionId: sid, status: 'active' } })
    const steps = JSON.parse(row.stepsJson)
    expect(steps[0].status).toBe('pending')
    expect(chunks.filter((c) => c.type === 'plan_updated' && (c as any).source === 'system')).toHaveLength(0)
  })
})

describe('#979 方案 A/B/D — 行为 nudge / 轮次预警 / 进度读账本', () => {
  test('方案 A: 无清单 + 已执行 ≥3 工具调用 → 注入中性 nudge（一次性）', async () => {
    const ctx = makeCtx('doc-doc16')
    const registry = new ToolRegistry(ctx)
    let n = 0
    const probe = new ProbeTool(() => Promise.resolve({ success: true, output: '{"hits":[]}' }))
    Object.defineProperty(probe, 'name', { value: 'search_past_chats' })
    registry.register(probe)

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"search_past_chats","arguments":{"query":"a"}}'))
      .mockResolvedValueOnce(callBlock('{"name":"search_past_chats","arguments":{"query":"b"}}'))
      .mockResolvedValueOnce(callBlock('{"name":"search_past_chats","arguments":{"query":"c"}}'))
      .mockResolvedValueOnce('基于三次检索的结果……')

    const { io } = makeIO()
    const result = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '查查相关研究' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_1', sessionId: 'doc-doc16',
    })

    const nudges = result.messages.filter((m: any) => m.role === 'user' && String(m.content).includes('建议先调用 set_task_plan'))
    console.log('DBG_CALLS', vi.mocked(deepseekChat).mock.calls.length, 'DBG_COUNTS', nudges.map((m: any) => String(m.content).match(/已执行 (\\d+) 个/)?.[1]))
    expect(nudges).toHaveLength(1)
    expect(String(nudges[0].content)).toContain('已执行 3 个工具调用')
  })

  test('方案 A: 有活跃清单 → 不 nudge', async () => {
    const sid = UNIQUE()
    await ensureUser('user_plan11')
    await new SetTaskPlanTool({ userId: 'user_plan11', sessionId: sid }).execute({
      action: 'create', title: 'T',
      steps: [{ title: 'A', tool: 'edit_document' }, { title: 'B', tool: 'edit_document' }, { title: 'C', tool: 'edit_document' }],
    })

    const ctx = makeCtx(sid)
    const registry = new ToolRegistry(ctx)
    const probe = new ProbeTool(() => Promise.resolve({ success: true, output: '{"hits":[]}' }))
    Object.defineProperty(probe, 'name', { value: 'search_past_chats' })
    registry.register(probe)

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"search_past_chats","arguments":{}}'))
      .mockResolvedValueOnce('继续。')

    const { io } = makeIO()
    const result = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '继续' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_plan11', sessionId: sid,
    })
    expect(result.messages.some((m: any) => String(m.content).includes('建议先调用 set_task_plan'))).toBe(false)
  })

  test('方案 D: 进度问答 + 活跃清单 → 读账本强指令注入', async () => {
    const sid = UNIQUE()
    await ensureUser('user_plan12')
    await new SetTaskPlanTool({ userId: 'user_plan12', sessionId: sid }).execute({
      action: 'create', title: 'T',
      steps: [{ title: 'A', tool: 'edit_document' }, { title: 'B', tool: 'edit_document' }, { title: 'C', tool: 'edit_document' }],
    })

    const ctx = makeCtx(sid)
    const registry = new ToolRegistry(ctx)

    vi.mocked(deepseekChat).mockResolvedValueOnce('根据任务清单：1/3 步已完成（A）。')

    const { io } = makeIO()
    const result = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '到哪里了' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_plan12', sessionId: sid,
    })

    const instruction = result.messages.find((m: any) => String(m.content).includes('回答必须逐字依据「当前任务清单」段'))
    expect(instruction).toBeTruthy()
  })

  test('方案 D: 无进度问答 → 不注入', async () => {
    const sid = UNIQUE()
    await ensureUser('user_plan13')
    await new SetTaskPlanTool({ userId: 'user_plan13', sessionId: sid }).execute({
      action: 'create', title: 'T',
      steps: [{ title: 'A', tool: 'edit_document' }, { title: 'B', tool: 'edit_document' }, { title: 'C', tool: 'edit_document' }],
    })

    const ctx = makeCtx(sid)
    const registry = new ToolRegistry(ctx)

    vi.mocked(deepseekChat).mockResolvedValueOnce('好的。')

    const { io } = makeIO()
    const result = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '谢谢' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_plan13', sessionId: sid,
    })

    expect(result.messages.some((m: any) => String(m.content).includes('回答必须逐字依据'))).toBe(false)
  })
})
