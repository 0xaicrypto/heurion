import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { runToolCallLoop, type TurnIO } from '../../src/modules/chat/tool-loop.js'
import { ToolRegistry } from '../../src/tools/tool-registry.js'
import { BaseTool, type ToolResult } from '../../src/tools/base-tool.js'
import type { ChatStreamChunk } from '@heurion/contracts'

vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'

/**
 * #1106 — tool-loop 回合生命周期特性测试锚（characterization tests）。
 *
 * 既有 tool-loop-* 测试覆盖预算/熔断/doom/并行/presenter;本文件补齐
 * 重构前必须钉死的「回合状态机」可观测行为：
 *   - 单工具回合的事件序列（tool_call pending→running→completed +
 *     tool_result，seq 单调、SSE round 标注）
 *   - 失败工具的事件序列（completed → error 分支）
 *   - 空回复收尾（兜底文案 + 不发轮次上限提示）
 *   - 子代理（delegate）SSE 生命周期（subagent_started/subagent_done,
 *     id=sub_<seq>, 成败同帧）
 * 这些锚在重构后必须逐字保持 — 状态机提取(TurnState)是纯内部形态变更。
 */

// 运行时构造 tool-call 文本协议标记(避免测试源码出现可执行协议明文)。
const LT = String.fromCharCode(60)
const OPEN = LT + 'tool_call' + '>'
const CLOSE = LT + '/' + 'tool_call' + '>'
const callBlock = (json: string) => OPEN + json + CLOSE

const makeCtx = (sessionId = 'sess_state'): any => ({
  userId: 'user_1',
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

function probeNamed(name: string, run: () => Promise<ToolResult>): BaseTool {
  const probe = new ProbeTool(run)
  Object.defineProperty(probe, 'name', { value: name })
  return probe
}

function makeIO() {
  const chunks: ChatStreamChunk[] = []
  const io: TurnIO = { send: (c) => chunks.push(c), signal: new AbortController().signal }
  return { io, chunks }
}

beforeEach(() => { vi.mocked(deepseekChat).mockReset() })

describe('#1106 tool-loop 回合生命周期 — 事件序列锚', () => {
  test('成功工具回合:pending→running→completed + tool_result,seq 单调,SSE 先 call 后 result', async () => {
    const ctx = makeCtx()
    const registry = new ToolRegistry(ctx)
    registry.register(probeNamed('search_medical_web', () => Promise.resolve({ success: true, output: 'hits' })))

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"search_medical_web","arguments":{"query":"EGFR"}}'))
      .mockResolvedValueOnce('回答完成。')

    const { io, chunks } = makeIO()
    const result = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '查一下' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_1', sessionId: 'sess_state',
    })

    // 事件序列:tool_call(pending)→tool_call(running)→tool_call(completed)→tool_result
    const events = ctx.eventLog.append.mock.calls.map((c: any[]) => c[0])
    const seqs = events.filter((e: any) => e.eventType === 'tool_call').map((e: any) => e.metadata.seq)
    expect(seqs).toEqual([1, 1, 1])
    const statuses = events.filter((e: any) => e.eventType === 'tool_call').map((e: any) => e.metadata.status)
    expect(statuses).toEqual(['pending', 'running', 'completed'])
    const toolResult = events.find((e: any) => e.eventType === 'tool_result')
    expect(toolResult).toMatchObject({ eventType: 'tool_result', content: 'hits' })
    expect(toolResult.metadata).toMatchObject({ toolCallId: 1, success: true })

    // SSE:tool_call(chip)→tool_result(闭合),同 seq、round=1
    const sseCall = chunks.find((c) => c.type === 'tool_call') as any
    const sseResult = chunks.find((c) => c.type === 'tool_result') as any
    expect(sseCall).toMatchObject({ tool: 'search_medical_web', seq: 1, round: 1 })
    expect(sseResult).toMatchObject({ seq: 1, tool: 'search_medical_web', success: true, round: 1 })
    expect(sseResult.elapsed_ms).toBeGreaterThanOrEqual(0)
    expect(sseResult.preview).toBe('hits')

    expect(result.finalContent).toBe('回答完成。')
    expect(result.writeAttempts).toBe(0)
    expect(result.writeSuccesses).toBe(0)
    expect(result.unbackedClaimCount).toBe(0)
    expect(result.exhaustedReason).toBeUndefined()
  })

  test('失败工具回合:error 分支留痕,tool_result success=false,回合不中断', async () => {
    const ctx = makeCtx()
    const registry = new ToolRegistry(ctx)
    registry.register(probeNamed('search_medical_web', () => Promise.resolve({ success: false, error: 'boom' })))

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"search_medical_web","arguments":{"query":"x"}}'))
      .mockResolvedValueOnce('我说明一下失败原因。')

    const { io } = makeIO()
    const result = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '查' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_1', sessionId: 'sess_state',
    })

    const events = ctx.eventLog.append.mock.calls.map((c: any[]) => c[0])
    const statuses = events.filter((e: any) => e.eventType === 'tool_call').map((e: any) => e.metadata.status)
    expect(statuses).toEqual(['pending', 'running', 'error'])
    const toolResult = events.find((e: any) => e.eventType === 'tool_result')
    expect(toolResult.metadata).toMatchObject({ toolCallId: 1, success: false, error: 'boom' })
    expect(result.finalContent).toBe('我说明一下失败原因。')
  })

  test('空字符串回复:finalContent 为空(流式兜底由 conversation-turn 接管),不发轮次上限提示', async () => {
    const ctx = makeCtx()
    const registry = new ToolRegistry(ctx)

    vi.mocked(deepseekChat).mockResolvedValueOnce('')

    const { io, chunks } = makeIO()
    const result = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '你好' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_1', sessionId: 'sess_state',
    })

    expect(result.finalContent).toBe('')
    expect(chunks.some((c) => c.type === 'context_info' && String((c as any).text).includes('轮次已达上限'))).toBe(false)
  })

  test('未闭合工具调用块泄漏回复:统一清理后为空 → 兜底文案(非 doc 会话)', async () => {
    const ctx = makeCtx()
    const registry = new ToolRegistry(ctx)

    // 未闭合的 <tool_call>(无 </tool_call>) — 正则匹配失败,stripToolCallBlocks
    // 兜底清理(#1033),清理后为空 → 固定兜底文案。
    vi.mocked(deepseekChat).mockResolvedValueOnce(LT + 'tool_call>{"name":"probe"}')

    const { io } = makeIO()
    const result = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '你好' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_1', sessionId: 'sess_state',
    })

    expect(result.finalContent).toBe('抱歉，我未能完成这个操作，请再试一次或换一种说法描述需求。')
  })

  test('子代理 delegate:SSE subagent_started→subagent_done(id=sub_<seq>),成败同帧', async () => {
    const ctx = makeCtx()
    const registry = new ToolRegistry(ctx)
    registry.register(probeNamed('delegate', () => Promise.resolve({ success: true, output: '{"summary":"子任务完成","cost_tokens":42,"turns":2,"summary_preview":"完成了"}' })))

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"delegate","arguments":{"task":"调研 EGFR","scope":"medical"}}'))
      .mockResolvedValueOnce('子任务结果已汇总。')

    const { io, chunks } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '调研' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_1', sessionId: 'sess_state',
    })

    const started = chunks.find((c) => c.type === 'subagent_started') as any
    const done = chunks.find((c) => c.type === 'subagent_done') as any
    expect(started).toMatchObject({ id: 'sub_1', task: '调研 EGFR', scope: 'medical' })
    expect(done).toMatchObject({ id: 'sub_1', success: true, cost_tokens: 42 })
    expect(chunks.indexOf(started)).toBeLessThan(chunks.indexOf(done))
  })
})
