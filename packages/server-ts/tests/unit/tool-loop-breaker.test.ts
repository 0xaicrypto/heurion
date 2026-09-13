import { describe, test, expect, vi, beforeEach } from 'vitest'
import { LlmReasoningBudgetExceededError } from '../../src/common/llm-gateway.js'
import { TurnBudget } from '../../src/modules/chat/turn-budget.js'
import { ToolRegistry } from '../../src/tools/tool-registry.js'
import type { TurnIO } from '../../src/modules/chat/tool-loop.js'
import type { ChatStreamChunk } from '@heurion/contracts'

/**
 * #1026 — 流内 reasoning 熔断:
 *  - 流式调用越线抛 LlmReasoningBudgetExceededError → 循环立即结束,
 *    不回退非流式（否则继续烧预算）;
 *  - 非流式回退路径没有流内中止 → 事后判定,越线同样熔断。
 */
const mocks = vi.hoisted(() => ({ stream: vi.fn(), meta: vi.fn() }))

vi.mock('../../src/common/llm.js', () => ({
  deepseekChatWithToolsStream: mocks.stream,
  deepseekChatWithMeta: mocks.meta,
  getApiKey: () => 'k',
}))

import { runToolCallLoop } from '../../src/modules/chat/tool-loop.js'

const testCtx: any = {
  userId: 'user_1',
  sessionId: 'sess_breaker',
  eventLog: { append: vi.fn(), query: () => [], count: () => 0 },
  memory: { graph: { getAllNodes: () => [] } },
  facts: { all: () => [] },
  episodes: { all: () => [] },
  skills: { all: () => [] },
  knowledge: { all: () => [] },
}

function makeIO() {
  const chunks: ChatStreamChunk[] = []
  const io: TurnIO = { send: (c) => chunks.push(c), signal: new AbortController().signal }
  return { io, chunks }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('#1026 reasoning 熔断', () => {
  test('流式越线 → 立即结束回合,不回退非流式,原因固化 reasoning', async () => {
    mocks.stream.mockRejectedValueOnce(new LlmReasoningBudgetExceededError({ reasoningChars: 160_000, maxReasoningChars: 150_000 }))
    const budget = new TurnBudget({ maxRounds: 5 })
    const { io } = makeIO()
    const res = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: 'x' }],
      toolRegistry: new ToolRegistry(testCtx),
      tools: [],
      apiKey: 'k',
      io,
      ctx: testCtx,
      userId: 'user_1',
      sessionId: 'sess_breaker',
      budget,
    })

    expect(res.exhaustedReason).toBe('reasoning')
    expect(budget.exhaustedReason).toBe('reasoning')
    expect(budget.snapshot().rounds).toBe(1)
    expect(mocks.meta).not.toHaveBeenCalled()
  })

  test('非流式回退路径 reasoning 越线 → 事后熔断(不再执行工具/下一轮)', async () => {
    mocks.stream.mockRejectedValueOnce(new Error('stream unsupported'))
    mocks.meta.mockImplementationOnce(async (_m: unknown, _k: unknown, _o: unknown, _t: unknown, onReasoning?: (t: string) => void) => {
      onReasoning?.('思'.repeat(200))
      return { text: '', truncated: false }
    })
    const budget = new TurnBudget({ maxRounds: 5, maxReasoningChars: 100 })
    const { io } = makeIO()
    const res = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: 'x' }],
      toolRegistry: new ToolRegistry(testCtx),
      tools: [],
      apiKey: 'k',
      io,
      ctx: testCtx,
      userId: 'user_1',
      sessionId: 'sess_breaker',
      budget,
    })

    expect(res.exhaustedReason).toBe('reasoning')
    expect(budget.exhaustedReason).toBe('reasoning')
    expect(budget.snapshot().rounds).toBe(1)
  })
})
