import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { runToolCallLoop, type TurnIO } from '../../src/modules/chat/tool-loop.js'
import { countClaimedEditItems } from '../../src/modules/chat/writing-prompts.js'
import { ToolRegistry } from '../../src/tools/tool-registry.js'
import { BaseTool, type ToolResult } from '../../src/tools/base-tool.js'
import type { ChatStreamChunk } from '@heurion/contracts'

vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'

/**
 * P0 hotfix 2026-09(原 #892)— 声明-执行对账守卫新语义:doc- 会话回复
 * 声称已完成编辑但零写回 → 仅事件留痕(edit_claim_unbacked)+ 用户可见
 * 警示,不再原地注入纠偏消息重试(毒上下文重试无效);重试职责移交
 * doc-executor(见 doc-executor.test.ts)。
 * #893 — 轮次上限提示保持不变:doc- 会话轮次耗尽退出且本轮执行过工具 →
 * 提示用户回复「继续」接力。
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

describe('声明-执行对账守卫(P0 hotfix 新语义:零写回+声明 → 留痕,不重试)', () => {
  test('doc- 会话声称完成编辑但零写回 → 事件留痕 + 警示,不再原地重试', async () => {
    const ctx = makeCtx('doc-doc1')
    const registry = new ToolRegistry(ctx)
    registry.register(new ProbeTool(() => Promise.resolve({ success: true, output: '{"body":"x"}' })))

    vi.mocked(deepseekChat).mockResolvedValueOnce('已经完成修改，正文已更新完毕。')

    const { io, chunks } = makeIO()
    const { finalContent, executedWriteTools } = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '帮我把第三章改成英文' }],
      toolRegistry: registry,
      tools: [],
      apiKey: 'k',
      io,
      ctx,
      userId: 'user_1',
      sessionId: 'doc-doc1',
    })

    // 新语义:单次 LLM 调用,无纠偏重试;finalContent 原样返回(调用方
    // doc-executor 接管重试决策)。
    expect(deepseekChat).toHaveBeenCalledTimes(1)
    expect(finalContent).toBe('已经完成修改，正文已更新完毕。')
    expect(executedWriteTools).toEqual([])

    // 事件留痕:edit_claim_unbacked;纠偏消息不落 user_message
    const events = ctx.eventLog.append.mock.calls.map((c: any[]) => c[0])
    const unbacked = events.filter((e: any) => e.eventType === 'edit_claim_unbacked')
    expect(unbacked).toHaveLength(1)
    expect(unbacked[0].metadata.claimedEdit).toBe(true)
    expect(events.some((e: any) => e.eventType === 'user_message')).toBe(false)

    // SSE 警示对用户可见
    const infos = chunks.filter((c) => c.type === 'context_info')
    expect(infos.some((c) => String((c as any).text).includes('未产生任何写回工具调用'))).toBe(true)
  })

  test('写回工具已执行(即使失败) → 不触发守卫,executedWriteTools 含工具名', async () => {
    const ctx = makeCtx('doc-doc2')
    const registry = new ToolRegistry(ctx)
    const probe = new ProbeTool(() => Promise.resolve({ success: false, error: 'old_text not found' }))
    Object.defineProperty(probe, 'name', { value: 'edit_document' })
    registry.register(probe)

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"edit_document","arguments":{"old_text":"a","new_text":"b"}}'))
      .mockResolvedValueOnce('已经完成修改。')

    const { io, chunks } = makeIO()
    const { finalContent, executedWriteTools } = await runToolCallLoop({
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
    expect(executedWriteTools).toEqual(['edit_document'])
    const events = ctx.eventLog.append.mock.calls.map((c: any[]) => c[0])
    expect(events.some((e: any) => e.eventType === 'edit_claim_unbacked')).toBe(false)
    expect(chunks.filter((c) => c.type === 'context_info')).toHaveLength(0)
  })

  test('非 doc 会话声明不触发守卫', async () => {
    const ctx = makeCtx('session_x1')
    const registry = new ToolRegistry(ctx)

    vi.mocked(deepseekChat).mockResolvedValueOnce('已经完成分析并更新了结论。')

    const { io } = makeIO()
    const { executedWriteTools } = await runToolCallLoop({
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
    expect(executedWriteTools).toEqual([])
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

describe('#967 部分执行对账 — countClaimedEditItems(纯函数)', () => {
  test('对照表行数计条数(表头/分隔行排除)', () => {
    const reply = [
      '| 原意见（Sections 清单） | 实际改动 | 所在章节 |',
      '|---|---|---|',
      '| Title page | 已有，未改动 | 文首 |',
      '| Introduction | 新增：EGFR-TKI 标准治疗 → 免疫 | Introduction |',
      '| Patients and methods | 新增：设计与患者 | Patients and methods |',
      '| Results | 新增：患者特征 | Results |',
      '| Discussion | 新增：主要发现 | Discussion |',
    ].join('\n')
    expect(countClaimedEditItems(reply)).toBe(5)
  })

  test('进度话术「已完成 X/Y」取最大 claimed', () => {
    expect(countClaimedEditItems('已完成 3/5：PFS、OS、安全性；剩余 2 节')).toBe(3)
    expect(countClaimedEditItems('意见 2/共 5 已落实')).toBe(2)
  })

  test('诚实单条进度(已完成 1/5)不虚报', () => {
    expect(countClaimedEditItems('已完成 1/5：Introduction')).toBe(1)
  })

  test('无声明内容 → 0', () => {
    expect(countClaimedEditItems('这是一段普通的说明文字。')).toBe(0)
  })

  test('tool-loop 守卫:声称 6 处但仅写回 1 处 → partial 警示 + 事件 + unbackedClaimCount 透出', async () => {
    const ctx = makeCtx('doc-doc9')
    const registry = new ToolRegistry(ctx)
    const probe = new ProbeTool(() => Promise.resolve({ success: true, output: '{"body":"x","summary":"已写入 Introduction"}' }))
    Object.defineProperty(probe, 'name', { value: 'edit_document' })
    registry.register(probe)

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"edit_document","arguments":{"old_text":"Introduction 段落","new_text":"Introduction 新内容"}}'))
      .mockResolvedValueOnce([
        '| 原意见（Sections 清单） | 实际改动 | 所在章节 |',
        '|---|---|---|',
        '| Introduction | 新增：A | Introduction |',
        '| Patients and methods | 新增：设计与患者 | Methods |',
        '| Results | 新增：患者特征 | Results |',
        '| Discussion | 新增：主要发现 | Discussion |',
      ].join('\n'))

    const { io, chunks } = makeIO()
    const result = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '按 section 逐节填充内容' }],
      toolRegistry: registry,
      tools: [],
      apiKey: 'k',
      io,
      ctx,
      userId: 'user_1',
      sessionId: 'doc-doc9',
    })

    expect(result.executedWriteTools).toEqual(['edit_document'])
    expect(result.unbackedClaimCount).toBe(4)

    const events = ctx.eventLog.append.mock.calls.map((c: any[]) => c[0])
    const partial = events.filter((e: any) => e.eventType === 'edit_claim_unbacked')
    expect(partial).toHaveLength(1)
    expect(partial[0].metadata).toMatchObject({ claimedCount: 4, docWriteExecuted: 1, kind: 'partial' })

    const infos = chunks.filter((c) => c.type === 'context_info')
    expect(infos.some((c) => String((c as any).text).includes('实际写回 1 处'))).toBe(true)
  })

  test('对账一致(声称 1 写回 1)→ 不触发 partial 警示', async () => {
    const ctx = makeCtx('doc-doc10')
    const registry = new ToolRegistry(ctx)
    const probe = new ProbeTool(() => Promise.resolve({ success: true, output: '{"body":"x","summary":"已写入"}' }))
    Object.defineProperty(probe, 'name', { value: 'edit_document' })
    registry.register(probe)

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"edit_document","arguments":{"old_text":"a","new_text":"b"}}'))
      .mockResolvedValueOnce('已完成 1/5：Introduction 写入完成。回复「继续」处理下一节。')

    const { io } = makeIO()
    const result = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '逐节填充' }],
      toolRegistry: registry,
      tools: [],
      apiKey: 'k',
      io,
      ctx,
      userId: 'user_1',
      sessionId: 'doc-doc10',
    })

    expect(result.unbackedClaimCount).toBe(0)
    const events = ctx.eventLog.append.mock.calls.map((c: any[]) => c[0])
    expect(events.some((e: any) => e.eventType === 'edit_claim_unbacked')).toBe(false)
  })
})
