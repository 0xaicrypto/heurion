import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { runToolCallLoop, type TurnIO } from '../../src/modules/chat/tool-loop.js'
import { ToolRegistry } from '../../src/tools/tool-registry.js'
import { BaseTool, type ToolResult } from '../../src/tools/base-tool.js'
import { EDIT_CLAIM_CORRECTION } from '../../src/modules/chat/writing-prompts.js'
import type { ChatStreamChunk } from '@heurion/contracts'

vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'

/**
 * #892 — 声明-执行对账守卫(生产事故根因①):doc- 会话回复声称已完成编辑,
 * 但本轮没有任何写回工具执行 → 事件留痕(edit_claim_unbacked)+ 用户可见
 * 警示 + 注入纠偏消息重试一轮(仅一次),纠偏消息不落 user_message。
 * #893 — 轮次上限 × 每轮一次编辑规则(事故根因②):doc- 会话轮次耗尽退出
 * 且本轮执行过工具 → 提示用户回复「继续」接力。
 */

// 运行时构造 tool-call 文本协议标记(避免测试源码出现可执行协议明文)。
const LT = String.fromCharCode(60)
const OPEN = LT + 'tool_call' + '>'
const CLOSE = LT + '/' + 'tool_call' + '>'
const callBlock = (json: string) => OPEN + json + CLOSE

const makeCtx = (sessionId: string): any => ({
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

function makeIO() {
  const chunks: ChatStreamChunk[] = []
  const io: TurnIO = { send: (c) => chunks.push(c), signal: new AbortController().signal }
  return { io, chunks }
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.clearAllMocks())

describe('#892 声明-执行对账守卫', () => {
  test('doc- 会话声称完成编辑但零写回 → 留痕 + 警示 + 纠偏重试一轮', async () => {
    const ctx = makeCtx('doc-doc1')
    const registry = new ToolRegistry(ctx)
    registry.register(new ProbeTool(() => Promise.resolve({ success: true, output: '{"body":"x"}' })))

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce('已经完成修改，正文已更新完毕。') // 声明但零写回
      .mockResolvedValueOnce('文档未做任何修改。') // 纠偏轮如实回答

    const { io, chunks } = makeIO()
    const { finalContent } = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '帮我把第三章改成英文' }],
      toolRegistry: registry,
      tools: [],
      apiKey: 'k',
      io,
      ctx,
      userId: 'user_1',
      sessionId: 'doc-doc1',
    })

    // 纠偏重试发生(第二次 LLM 调用)
    expect(deepseekChat).toHaveBeenCalledTimes(2)
    expect(finalContent).toBe('文档未做任何修改。')

    // 事件留痕:edit_claim_unbacked;且纠偏消息不落 user_message
    const events = ctx.eventLog.append.mock.calls.map((c: any[]) => c[0])
    const unbacked = events.filter((e: any) => e.eventType === 'edit_claim_unbacked')
    expect(unbacked).toHaveLength(1)
    expect(events.some((e: any) => e.eventType === 'user_message')).toBe(false)

    // SSE 警示对用户可见
    const infos = chunks.filter((c) => c.type === 'context_info')
    expect(infos.some((c) => String((c as any).text).includes('未产生任何写回工具调用'))).toBe(true)

    // 纠偏消息注入对话(下一轮 LLM 输入末尾)
    const secondCallMessages = (vi.mocked(deepseekChat).mock.calls[1]?.[0] ?? []) as any[]
    expect(secondCallMessages.some((m) => String(m.content) === EDIT_CLAIM_CORRECTION)).toBe(true)
  })

  test('写回工具已执行(即使失败) → 不触发守卫', async () => {
    const ctx = makeCtx('doc-doc2')
    const registry = new ToolRegistry(ctx)
    registry.register(new ProbeTool(() => Promise.resolve({ success: false, error: 'old_text not found' })))

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"edit_document","arguments":{"old_text":"a","new_text":"b"}}'))
      .mockResolvedValueOnce('已经完成修改。')

    const { io, chunks } = makeIO()
    const { finalContent } = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '改一下' }],
      toolRegistry: registry,
      tools: [],
      apiKey: 'k',
      io,
      ctx,
      userId: 'user_1',
      sessionId: 'doc-doc2',
    })

    expect(finalContent).toBe('已经完成修改。')
    const events = ctx.eventLog.append.mock.calls.map((c: any[]) => c[0])
    expect(events.some((e: any) => e.eventType === 'edit_claim_unbacked')).toBe(false)
    expect(chunks.filter((c) => c.type === 'context_info')).toHaveLength(0)
  })

  test('守卫只重试一次 — 纠偏轮再声明不再触发', async () => {
    const ctx = makeCtx('doc-doc3')
    const registry = new ToolRegistry(ctx)
    registry.register(new ProbeTool(() => Promise.resolve({ success: true, output: '{"body":"x"}' })))

    vi.mocked(deepseekChat).mockResolvedValue('已完成整理并重构完毕。')

    const { io } = makeIO()
    const { finalContent } = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '整理全文' }],
      toolRegistry: registry,
      tools: [],
      apiKey: 'k',
      io,
      ctx,
      userId: 'user_1',
      sessionId: 'doc-doc3',
    })

    expect(deepseekChat).toHaveBeenCalledTimes(2)
    expect(finalContent).toContain('已完成整理')
    const events = ctx.eventLog.append.mock.calls.map((c: any[]) => c[0])
    expect(events.filter((e: any) => e.eventType === 'edit_claim_unbacked')).toHaveLength(1)
  })

  test('非 doc 会话声明不触发守卫', async () => {
    const ctx = makeCtx('session_x1')
    const registry = new ToolRegistry(ctx)

    vi.mocked(deepseekChat).mockResolvedValueOnce('已经完成分析并更新了结论。')

    const { io } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '分析一下' }],
      toolRegistry: registry,
      tools: [],
      apiKey: 'k',
      io,
      ctx,
      userId: 'user_1',
      sessionId: 'session_x1',
    })

    expect(deepseekChat).toHaveBeenCalledTimes(1)
    const events = ctx.eventLog.append.mock.calls.map((c: any[]) => c[0])
    expect(events.some((e: any) => e.eventType === 'edit_claim_unbacked')).toBe(false)
  })
})

describe('#893 轮次上限提示', () => {
  test('doc- 会话连跑 5 轮工具耗尽 → 提示回复「继续」接力', async () => {
    const ctx = makeCtx('doc-doc4')
    const registry = new ToolRegistry(ctx)
    const probe = new ProbeTool(() => Promise.resolve({ success: true, output: 'hits' }))
    Object.defineProperty(probe, 'name', { value: 'search_medical_web' })
    registry.register(probe)

    vi.mocked(deepseekChat).mockImplementation(async () =>
      callBlock('{"name":"search_medical_web","arguments":{"query":"x"}}'))

    const { io, chunks } = makeIO()
    const { finalContent } = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '写吧' }],
      toolRegistry: registry,
      tools: [],
      apiKey: 'k',
      io,
      ctx,
      userId: 'user_1',
      sessionId: 'doc-doc4',
    })

    expect(deepseekChat).toHaveBeenCalledTimes(5)
    expect(finalContent).toBe('')
    expect(chunks.some((c) => c.type === 'context_info' && String((c as any).text).includes('轮次已达上限'))).toBe(true)
  })

  test('非 doc 会话轮次耗尽不提示', async () => {
    const ctx = makeCtx('session_x2')
    const registry = new ToolRegistry(ctx)
    const probe = new ProbeTool(() => Promise.resolve({ success: true, output: 'hits' }))
    Object.defineProperty(probe, 'name', { value: 'search_medical_web' })
    registry.register(probe)

    vi.mocked(deepseekChat).mockImplementation(async () =>
      callBlock('{"name":"search_medical_web","arguments":{"query":"x"}}'))

    const { io, chunks } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: 'x' }],
      toolRegistry: registry,
      tools: [],
      apiKey: 'k',
      io,
      ctx,
      userId: 'user_1',
      sessionId: 'session_x2',
    })

    expect(chunks.some((c) => c.type === 'context_info' && String((c as any).text).includes('轮次已达上限'))).toBe(false)
  })
})
