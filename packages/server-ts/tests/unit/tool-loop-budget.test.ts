import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { runToolCallLoop, type TurnIO } from '../../src/modules/chat/tool-loop.js'
import { ToolRegistry } from '../../src/tools/tool-registry.js'
import { BaseTool, type ToolResult } from '../../src/tools/base-tool.js'
import { TurnBudget } from '../../src/modules/chat/turn-budget.js'
import type { ChatStreamChunk } from '@heurion/contracts'

vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'

/**
 * #1019 — main 与 rescue 共享同一个回合级预算:
 *  - 预算轮次用尽 → 循环不再发起下一次 LLM 调用,返回 exhaustedReason;
 *  - rescue（第二次 runToolCallLoop）消费的是剩余额度,不另领 5 轮;
 *  - 工具调用数/推理字数等维度同口径。
 */

const callBlock = (json: string) => `<tool_call>${json}</tool_call>`

const testCtx: any = {
  userId: 'user_1',
  sessionId: 'sess_budget',
  eventLog: { append: vi.fn(), query: () => [], count: () => 0 },
  memory: { graph: { getAllNodes: () => [] } },
  facts: { all: () => [] },
  episodes: { all: () => [] },
  skills: { all: () => [] },
  knowledge: { all: () => [] },
}

class FailingTool extends BaseTool {
  constructor(private nameValue: string, private error: string) { super() }
  get name(): string { return this.nameValue }
  get description(): string { return this.nameValue }
  get parameters(): Record<string, unknown> { return { type: 'object', properties: {} } }
  async execute(): Promise<ToolResult> { return { success: false, error: this.error } }
}

function makeIO() {
  const chunks: ChatStreamChunk[] = []
  const io: TurnIO = { send: (c) => chunks.push(c), signal: new AbortController().signal }
  return { io, chunks }
}

const toolDef = (name: string) => [{ type: 'function' as const, function: { name, description: '', parameters: { type: 'object', properties: {} } } }]

// clearAllMocks 不清 once-impl 队列 — 残留 mockResolvedValueOnce 会跨用例
// 泄漏（documents-router 真实事故形态），这里按 mockReset 清干净。
beforeEach(() => vi.mocked(deepseekChat).mockReset())

describe('#1019 runToolCallLoop — 回合级预算', () => {
  test('轮次预算用尽:LLM 调用次数被封顶并返回 exhaustedReason', async () => {
    const registry = new ToolRegistry(testCtx)
    registry.register(new FailingTool('generate_image', 'HTTP 500 upstream error'))
    // 每轮换个参数,避免 doom-loop（同参三连）干扰预算断言
    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"generate_image","arguments":{"prompt":"a1"}}'))
      .mockResolvedValueOnce(callBlock('{"name":"generate_image","arguments":{"prompt":"a2"}}'))
      .mockResolvedValueOnce(callBlock('{"name":"generate_image","arguments":{"prompt":"a3"}}'))
      .mockResolvedValueOnce(callBlock('{"name":"generate_image","arguments":{"prompt":"a4"}}'))
      .mockResolvedValueOnce('收尾')

    const budget = new TurnBudget({ maxRounds: 3, maxWallMs: 10 * 60_000 })
    const { io } = makeIO()
    const res = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '生成' }],
      toolRegistry: registry,
      tools: toolDef('generate_image'),
      apiKey: 'k',
      io,
      ctx: testCtx,
      userId: 'user_1',
      sessionId: 'sess_budget',
      budget,
    })

    expect(vi.mocked(deepseekChat)).toHaveBeenCalledTimes(3)
    expect(res.exhaustedReason).toBe('rounds')
    expect(res.budget).toMatchObject({ rounds: 3, remainingRounds: 0 })
  })

  test('rescue 复用同一预算:main 用尽后第二次循环不再发起 LLM 调用', async () => {
    const registry = new ToolRegistry(testCtx)
    registry.register(new FailingTool('generate_image', 'HTTP 500 upstream error'))
    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"generate_image","arguments":{"prompt":"a1"}}'))
      .mockResolvedValueOnce(callBlock('{"name":"generate_image","arguments":{"prompt":"a2"}}'))
      .mockResolvedValueOnce(callBlock('{"name":"generate_image","arguments":{"prompt":"a3"}}'))
      .mockResolvedValueOnce(callBlock('{"name":"generate_image","arguments":{"prompt":"a4"}}'))
      .mockResolvedValueOnce('收尾')

    const budget = new TurnBudget({ maxRounds: 2, maxWallMs: 10 * 60_000 })
    const { io } = makeIO()
    const main = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '生成' }],
      toolRegistry: registry,
      tools: toolDef('generate_image'),
      apiKey: 'k',
      io,
      ctx: testCtx,
      userId: 'user_1',
      sessionId: 'sess_budget',
      budget,
    })
    expect(main.exhaustedReason).toBe('rounds')
    expect(vi.mocked(deepseekChat)).toHaveBeenCalledTimes(2)

    // rescue 形态:同预算再跑一次 → 额度已尽,零 LLM 调用
    const rescue = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '精简上下文重试' }],
      toolRegistry: registry,
      tools: toolDef('generate_image'),
      apiKey: 'k',
      io,
      ctx: testCtx,
      userId: 'user_1',
      sessionId: 'sess_budget',
      budget,
    })
    expect(vi.mocked(deepseekChat)).toHaveBeenCalledTimes(2)
    expect(rescue.exhaustedReason).toBe('rounds')
  })

  test('工具调用数预算:达上限后下一轮被拒(不再发起 LLM 调用)', async () => {
    const registry = new ToolRegistry(testCtx)
    registry.register(new FailingTool('generate_image', 'HTTP 500 upstream error'))
    vi.mocked(deepseekChat).mockResolvedValue(callBlock('{"name":"generate_image","arguments":{"prompt":"a1"}}'))

    const budget = new TurnBudget({ maxRounds: 5, maxToolCalls: 1, maxWallMs: 10 * 60_000 })
    const { io } = makeIO()
    const res = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '生成' }],
      toolRegistry: registry,
      tools: toolDef('generate_image'),
      apiKey: 'k',
      io,
      ctx: testCtx,
      userId: 'user_1',
      sessionId: 'sess_budget',
      budget,
    })

    expect(vi.mocked(deepseekChat)).toHaveBeenCalledTimes(1)
    expect(res.exhaustedReason).toBe('tool_calls')
  })

  test('#1023 修正性重试:上一轮失败 → 下一轮完成预算收紧,首轮不受限', async () => {
    const registry = new ToolRegistry(testCtx)
    registry.register(new FailingTool('generate_image', 'HTTP 500 upstream error'))
    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"generate_image","arguments":{"prompt":"a1"}}'))
      .mockResolvedValueOnce('已说明失败原因。')

    const budget = new TurnBudget({ maxRounds: 5, maxWallMs: 10 * 60_000 })
    const { io } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '生成' }],
      toolRegistry: registry,
      tools: toolDef('generate_image'),
      apiKey: 'k',
      io,
      ctx: testCtx,
      userId: 'user_1',
      sessionId: 'sess_budget',
      budget,
    })

    const first = vi.mocked(deepseekChat).mock.calls[0]?.[2] as { maxTokens?: number } | undefined
    const second = vi.mocked(deepseekChat).mock.calls[1]?.[2] as { maxTokens?: number } | undefined
    expect(first?.maxTokens).toBeUndefined()
    expect(second?.maxTokens).toBe(8192)
    // #1026 接线:预算存在时单次调用携带剩余 reasoning 额度
    expect(first?.maxReasoningChars).toBe(150_000)
  })
})
