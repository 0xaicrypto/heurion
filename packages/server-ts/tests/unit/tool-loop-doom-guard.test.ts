import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { runToolCallLoop, type TurnIO } from '../../src/modules/chat/tool-loop.js'
import { ToolRegistry } from '../../src/tools/tool-registry.js'
import { BaseTool, type ToolResult } from '../../src/tools/base-tool.js'
import type { ChatStreamChunk } from '@heurion/contracts'

vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'

/**
 * #927 — doom-loop 拦截:同参三连调用不再照常执行(pre-execution 拦截,
 * 优先于检索类 best-effort 降级等一切后置逻辑),芯片按 seq 闭合 +
 * 注入纠偏消息,模型下一轮换策略或向用户说明。
 */

const callBlock = (json: string) => `<tool_call>${json}</tool_call>`

const testCtx: any = {
  userId: 'user_1',
  sessionId: 'sess_1',
  eventLog: { append: vi.fn(), query: () => [], count: () => 0 },
  memory: { graph: { getAllNodes: () => [] } },
  facts: { all: () => [] },
  episodes: { all: () => [] },
  skills: { all: () => [] },
  knowledge: { all: () => [] },
}

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

describe('#927 tool-call loop — doom-loop 拦截', () => {
  test('同参第 3 次调用跳过执行:纠偏消息注入 + SSE 芯片闭合 + warning 留痕', async () => {
    let runs = 0
    const registry = new ToolRegistry(testCtx)
    const probe = new ProbeTool(() => {
      runs++
      return Promise.resolve({ success: true, output: '{"url":"https://img.example.org/a.png"}' })
    })
    Object.defineProperty(probe, 'name', { value: 'generate_image' }) // 写路径,非只读
    registry.register(probe)
    const defs = [{ type: 'function' as const, function: { name: 'generate_image', description: '', parameters: { type: 'object', properties: {} } } }]

    vi.mocked(deepseekChat)
      // 第 1 轮:同参 2 连调(未到 doom 阈值,照常执行)
      .mockResolvedValueOnce(
        callBlock('{"name":"generate_image","arguments":{"prompt":"a"}}') +
        callBlock('{"name":"generate_image","arguments":{"prompt":"a"}}'),
      )
      // 第 2 轮:同参第 3 次 → doom 拦截
      .mockResolvedValueOnce(callBlock('{"name":"generate_image","arguments":{"prompt":"a"}}'))
      // 第 3 轮:纠偏后收尾
      .mockResolvedValueOnce('已改用其他策略完成。')

    const { io, chunks } = makeIO()
    const { finalContent } = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '生成图' }],
      toolRegistry: registry,
      tools: defs,
      apiKey: 'k',
      io,
      ctx: testCtx,
      userId: 'user_1',
      sessionId: 'sess_1',
    })

    // 前两次照常执行,第 3 次被拦截(工具只跑了 2 次)
    expect(runs).toBe(2)
    expect(finalContent).toContain('已改用其他策略完成')

    // 纠偏消息注入模型上下文(第 3 轮 LLM 调用的 messages 中可见)
    const thirdCallMessages = (vi.mocked(deepseekChat).mock.calls[2]?.[0] ?? []) as any[]
    expect(thirdCallMessages.some((m) => String(m.content).includes('请更换策略或直接向用户说明'))).toBe(true)

    // SSE:第 3 次调用的芯片按 seq 闭合(success=false),不悬挂
    const calls = chunks.filter((c) => c.type === 'tool_call')
    const results = chunks.filter((c) => c.type === 'tool_result')
    expect(calls).toHaveLength(3)
    expect(results.map((c) => (c as any).seq)).toEqual([1, 2, 3])
    expect(results.map((c) => (c as any).success)).toEqual([true, true, false])

    // warning 事件留痕(现状保留)
    const events = testCtx.eventLog.append.mock.calls.map((c: any[]) => c[0])
    expect(events.some((e: any) => e.metadata?.tool === 'generate_image' && e.metadata?.status === 'warning')).toBe(true)
  })

  test('拦截优先于检索类 best-effort 降级 — 拦截路径不产生停用通知', async () => {
    let runs = 0
    const registry = new ToolRegistry(testCtx)
    // 检索类只读工具,成功返回(不触发 best-effort 失败计数)
    const probe = new ProbeTool(() => {
      runs++
      return Promise.resolve({ success: true, output: 'search hit' })
    })
    Object.defineProperty(probe, 'name', { value: 'search_medical_web' })
    registry.register(probe)
    const defs = [{ type: 'function' as const, function: { name: 'search_medical_web', description: '', parameters: { type: 'object', properties: {} } } }]

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(
        callBlock('{"name":"search_medical_web","arguments":{"query":"q"}}') +
        callBlock('{"name":"search_medical_web","arguments":{"query":"q"}}'),
      )
      .mockResolvedValueOnce(callBlock('{"name":"search_medical_web","arguments":{"query":"q"}}'))
      .mockResolvedValueOnce('done')

    const { io, chunks } = makeIO()
    const { finalContent, messages } = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: 'x' }],
      toolRegistry: registry,
      tools: defs,
      apiKey: 'k',
      io,
      ctx: testCtx,
      userId: 'user_1',
      sessionId: 'sess_1',
    })

    expect(runs).toBe(2)
    expect(finalContent).toBe('done')
    expect(messages.some((m) => String(m.content).includes('已因连续失败被停用'))).toBe(false)
    expect(messages.some((m) => String(m.content).includes('请更换策略或直接向用户说明'))).toBe(true)
    const results = chunks.filter((c) => c.type === 'tool_result')
    expect(results.map((c) => (c as any).seq)).toEqual([1, 2, 3])
    expect((results[2] as any).success).toBe(false)
  })
})

