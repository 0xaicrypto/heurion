import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { runToolCallLoop, type TurnIO } from '../../src/modules/chat/tool-loop.js'
import { ToolRegistry } from '../../src/tools/tool-registry.js'
import { VisitMedicalSiteTool } from '../../src/tools/medical-web-tools.js'
import { BaseTool, type ToolResult } from '../../src/tools/base-tool.js'
import type { ChatStreamChunk } from '@heurion/contracts'

vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'

/**
 * #835 — best-effort retrieval (尽最大努力检索):
 * 检索类只读工具连续失败 ≥2 次 → 后续轮次从 tools 列表移除该类工具,
 * 注入"检索兜底策略"指引,模型基于已有上下文继续产出,不再空转烧轮次。
 */

// 运行时构造 tool-call 文本协议标记(避免测试源码出现可执行协议明文)。
const LT = String.fromCharCode(60)
const OPEN = LT + 'tool_call' + '>'
const CLOSE = LT + '/' + 'tool_call' + '>'
const callBlock = (json: string) => OPEN + json + CLOSE

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

describe('#835 tool-call loop — best-effort retrieval', () => {
  test('连续 2 次检索失败 → 后续轮次移除检索工具并注入指引', async () => {
    const registry = new ToolRegistry(testCtx)
    const failTool = new ProbeTool(() =>
      Promise.resolve({ success: false, error: '站点禁止自动化访问（反爬拦截）' }))
    Object.defineProperty(failTool, 'name', { value: 'visit_medical_site' })
    registry.register(failTool)
    const defs = [
      { type: 'function' as const, function: { name: 'visit_medical_site', description: '', parameters: { type: 'object', properties: {} } } },
      { type: 'function' as const, function: { name: 'edit_document', description: '', parameters: { type: 'object', properties: {} } } },
    ]

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(
        callBlock('{"name":"visit_medical_site","arguments":{"url":"https://a.example.org"}}') +
        callBlock('{"name":"visit_medical_site","arguments":{"url":"https://b.example.org"}}'),
      )
      .mockResolvedValueOnce('已基于已有资料继续写作，未核实来源已如实标注。')

    const { io, chunks } = makeIO()
    const { finalContent, messages } = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '继续写' }],
      toolRegistry: registry,
      tools: defs,
      apiKey: 'k',
      io,
      ctx: testCtx,
      userId: 'user_1',
      sessionId: 'sess_1',
    })

    expect(finalContent).toContain('已基于已有资料继续写作')

    // 两次失败后,第二轮 LLM 调用的 tools 列表不再含检索工具(写工具保留)
    const secondCallTools = (vi.mocked(deepseekChat).mock.calls[1]?.[3] ?? []) as any[]
    expect(secondCallTools.some((t) => t.function.name === 'visit_medical_site')).toBe(false)
    expect(secondCallTools.some((t) => t.function.name === 'edit_document')).toBe(true)

    // 注入了兜底指引(每次失败一条) + 系统停用通知
    expect(messages.filter((m) => String(m.content).includes('检索兜底策略')).length).toBe(2)
    expect(messages.some((m) => String(m.content).includes('已因连续失败被停用'))).toBe(true)

    // 事件留痕:retrieval_degraded warning
    const events = testCtx.eventLog.append.mock.calls.map((c: any[]) => c[0])
    expect(events.some((e: any) => e.metadata?.tool === 'system' && e.metadata?.status === 'warning')).toBe(true)

    // SSE: 两次失败结果都按 seq 闭合
    const results = chunks.filter((c) => c.type === 'tool_result')
    expect(results.map((c) => (c as any).success)).toEqual([false, false])
  })

  test('单次检索失败不触发停用 — 模型可自行修正', async () => {
    const registry = new ToolRegistry(testCtx)
    let n = 0
    const flaky = new ProbeTool(() => {
      n++
      return n === 1
        ? Promise.resolve({ success: false, error: 'transient' })
        : Promise.resolve({ success: true, output: 'recovered data' })
    })
    Object.defineProperty(flaky, 'name', { value: 'search_medical_web' })
    registry.register(flaky)
    const defs = [{ type: 'function' as const, function: { name: 'search_medical_web', description: '', parameters: { type: 'object', properties: {} } } }]

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"search_medical_web","arguments":{"query":"x"}}'))
      .mockResolvedValueOnce('done')

    const { io } = makeIO()
    const { finalContent } = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: 'x' }],
      toolRegistry: registry,
      tools: defs,
      apiKey: 'k',
      io,
      ctx: testCtx,
      userId: 'user_1',
      sessionId: 'sess_1',
    })
    expect(finalContent).toBe('done')
    // 只失败 1 次 → 不停用,第二轮 tools 仍含该工具
    const secondCallTools = (vi.mocked(deepseekChat).mock.calls[1]?.[3] ?? []) as any[]
    expect(secondCallTools.some((t) => t.function.name === 'search_medical_web')).toBe(true)
  })

  // #837: 降级按工具粒度 — visit_medical_site 连败只停它自己,
  // 不再连坐 search_citation(生产实例:visit 抓 NCBI API 两次 →
  // PubMed 明明可用却被判"已停用")。
  test('visit_medical_site 连续失败只停用自身,search_citation 保持可用', async () => {
    const registry = new ToolRegistry(testCtx)
    const failTool = new ProbeTool(() =>
      Promise.resolve({ success: false, error: '站点禁止自动化访问（反爬拦截）' }))
    Object.defineProperty(failTool, 'name', { value: 'visit_medical_site' })
    registry.register(failTool)
    const defs = [
      { type: 'function' as const, function: { name: 'visit_medical_site', description: '', parameters: { type: 'object', properties: {} } } },
      { type: 'function' as const, function: { name: 'search_citation', description: '', parameters: { type: 'object', properties: {} } } },
    ]

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(
        callBlock('{"name":"visit_medical_site","arguments":{"url":"https://a.example.org"}}') +
        callBlock('{"name":"visit_medical_site","arguments":{"url":"https://b.example.org"}}'),
      )
      .mockResolvedValueOnce('done')

    const { io } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: 'x' }],
      toolRegistry: registry,
      tools: defs,
      apiKey: 'k',
      io,
      ctx: testCtx,
      userId: 'user_1',
      sessionId: 'sess_1',
    })

    const secondCallTools = (vi.mocked(deepseekChat).mock.calls[1]?.[3] ?? []) as any[]
    expect(secondCallTools.some((t) => t.function.name === 'visit_medical_site')).toBe(false)
    // 连坐修复的关键断言:search_citation 不被 visit 的失败牵连
    expect(secondCallTools.some((t) => t.function.name === 'search_citation')).toBe(true)
  })

  // #837: NCBI API 端点误用守卫 — visit_medical_site 抓 eutils URL 时
  // 成功返回改道指引(不计检索失败、不标黑名单)。
  test('visit_medical_site 访问 eutils API → 成功返回指引,不进失败计数', async () => {
    const registry = new ToolRegistry(testCtx)
    registry.register(new VisitMedicalSiteTool(testCtx))
    const defs = [{ type: 'function' as const, function: { name: 'visit_medical_site', description: '', parameters: { type: 'object', properties: {} } } }]

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"visit_medical_site","arguments":{"url":"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=x"}}'))
      .mockResolvedValueOnce('done')

    const { io } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: 'x' }],
      toolRegistry: registry,
      tools: defs,
      apiKey: 'k',
      io,
      ctx: testCtx,
      userId: 'user_1',
      sessionId: 'sess_1',
    })

    // 首轮消息不含兜底指引/停用通知(工具成功返回 → 未进失败计数)
    const secondCallMessages = (vi.mocked(deepseekChat).mock.calls[1]?.[0] ?? []) as any[]
    expect(secondCallMessages.some((m) => String(m.content).includes('检索兜底策略'))).toBe(false)
    expect(secondCallMessages.some((m) => String(m.content).includes('已因连续失败被停用'))).toBe(false)
  })
})
