import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { BaseTool, type ToolResult, type ToolDefinition } from '../../src/tools/base-tool.js'
import { ToolRegistry, type ToolContext } from '../../src/tools/tool-registry.js'
import type { ChatStreamChunk } from '@heurion/contracts'

/**
 * P0 hotfix 2026-09 — doc 执行器兜底(executor retry)单测。
 *
 * prisma 全量 mock(doc-session-gate.test.ts 同款 factory 模式),不触真实 DB;
 * llm mock 走共享 ai-mock(deepseekChatWithToolsStream 未 mock → 抛 TypeError
 * → tool-loop 回退 deepseekChatWithMeta → 命中 mock 的 deepseekChat)。
 */

const mocks = vi.hoisted(() => ({
  docFindFirst: vi.fn(),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: { doc: { findFirst: mocks.docFindFirst } },
}))

vi.mock('../../src/common/llm.js', () => mockAiProvider())

import { deepseekChat } from '../../src/common/llm.js'
import {
  shouldRunDocExecutor,
  runDocExecutorFallback,
  DOC_EDIT_INTENT_RE,
  DOC_EXECUTOR_FAILED_NOTICE,
} from '../../src/modules/chat/doc-executor.js'
import { EXECUTOR_RULE } from '../../src/modules/chat/writing-prompts.js'
import { runToolCallLoop, type TurnIO } from '../../src/modules/chat/tool-loop.js'

const VALID_DOC_ID = 'doc_00aa11bb22cc33dd'
const VALID_SESSION = `doc-${VALID_DOC_ID}`
const DOC_BODY = '## 摘要\n\n本研究为随机对照试验(方案待定)。\n\n## 方法\n\n纳入患者 120 例(流程待定)。'
const USER_TASK = '把摘要段润色并把所有「待定」替换为确认后的表述'

// 运行时构造 tool-call 文本协议标记(避免测试源码出现可执行协议明文)。
const LT = String.fromCharCode(60)
const OPEN = LT + 'tool_call' + '>'
const CLOSE = LT + '/' + 'tool_call' + '>'
const callBlock = (json: string) => OPEN + json + CLOSE

function makeCtx(sessionId: string): any {
  return {
    userId: 'user_1',
    sessionId,
    eventLog: { append: vi.fn(), query: () => [], count: () => 0 },
    memory: { graph: { getAllNodes: () => [] } },
    facts: { all: () => [] },
    episodes: { all: () => [] },
    skills: { all: () => [] },
    knowledge: { all: () => [] },
  }
}

class ProbeTool extends BaseTool {
  constructor(private run: () => Promise<ToolResult>) { super() }
  get name(): string { return 'probe' }
  get description(): string { return 'probe' }
  get parameters(): Record<string, unknown> { return { type: 'object', properties: {} } }
  async execute(): Promise<ToolResult> { return this.run() }
}

/** ProbeTool 重命名实例(与 edit-claim-guard.test.ts 同款做法)。 */
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

/** 模拟 conversation-turn 传入的工具面全集(写回 + 检索混合)。 */
function makeRegistryAndTools(ctx: ToolContext): { registry: ToolRegistry; tools: ToolDefinition[] } {
  const registry = new ToolRegistry(ctx)
  registry.register(probeNamed('edit_document', () => Promise.resolve({ success: true, output: '{"body":"<updated>","summary":"摘要段已润色,待定已替换"}' })))
  registry.register(probeNamed('search_medical_web', () => Promise.resolve({ success: true, output: 'hits' })))
  return { registry, tools: registry.definitions }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.docFindFirst.mockResolvedValue({ id: VALID_DOC_ID, userId: 'user_1', title: 'Test Doc', body: DOC_BODY })
})

describe('shouldRunDocExecutor 触发条件', () => {
  test('doc 会话 + 编辑意图 + 零写回 → 触发', () => {
    expect(shouldRunDocExecutor({ sessionId: VALID_SESSION, userText: USER_TASK, executedWriteTools: [] })).toBe(true)
  })

  test.each([
    ['非 doc 会话', { sessionId: 'session_x1', userText: USER_TASK, executedWriteTools: [] as string[] }],
    ['非编辑意图', { sessionId: VALID_SESSION, userText: '谢谢，请总结一下文档主旨', executedWriteTools: [] as string[] }],
    ['已有写回', { sessionId: VALID_SESSION, userText: USER_TASK, executedWriteTools: ['edit_document'] }],
  ])('%s → 不触发', (_name, input) => {
    expect(shouldRunDocExecutor(input)).toBe(false)
  })

  test('编辑意图正则覆盖中英关键词', () => {
    for (const t of ['润色这段', 'restructure the outline', 'please polish it', '把表格插入第二章']) {
      expect(DOC_EDIT_INTENT_RE.test(t)).toBe(true)
    }
    expect(DOC_EDIT_INTENT_RE.test('文档讲了什么')).toBe(false)
  })
})

describe('runDocExecutorFallback — 精简消息 + 写回工具面重跑', () => {
  test('doc + 编辑意图 + 零写回 → 执行器被调,消息精简(含文档全文/任务/方案,不含历史),tools 仅写回类', async () => {
    const ctx = makeCtx(VALID_SESSION)
    const { registry, tools } = makeRegistryAndTools(ctx)
    const planText = '方案：\n1. 润色摘要段\n2. 待定 → 已确认'

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce('计划如下：先润色摘要，再替换待定表述。') // 主回路(声明零写回)
      // 执行器两轮:调用时刻快照 messages(tool-loop 会原地 push,引用会被污染)
      .mockImplementationOnce(async (msgs: any[]) => {
        capturedMessages.push(JSON.parse(JSON.stringify(msgs)))
        return callBlock('{"name":"edit_document","arguments":{"old_text":"(方案待定)","new_text":"(方案已确认)","summary":"摘要待定替换"}}')
      })
      .mockImplementationOnce(async (msgs: any[]) => {
        capturedMessages.push(JSON.parse(JSON.stringify(msgs)))
        return '已完成修改：摘要段「(方案待定)」→「(方案已确认)」。'
      })

    const { io } = makeIO()
    const capturedMessages: any[][] = []
    // 主回路:声明零写回
    const main = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: USER_TASK }],
      toolRegistry: registry,
      tools,
      apiKey: 'k',
      io,
      ctx,
      userId: 'user_1',
      sessionId: VALID_SESSION,
    })
    expect(main.executedWriteTools).toEqual([])

    // 执行器兜底
    const rescue = await runDocExecutorFallback({
      userId: 'user_1',
      sessionId: VALID_SESSION,
      userText: USER_TASK,
      planText,
      apiKey: 'k',
      io,
      ctx,
      toolRegistry: registry,
      tools,
    })

    expect(rescue.executedWriteTools).toEqual(['edit_document'])
    expect(rescue.finalContent).toContain('已完成修改')

    // 执行器的 LLM 调用(调用时刻快照):capturedMessages[0] = 执行器第 1 轮
    const executorCall = capturedMessages[0]
    const [executorMessages] = [executorCall]
    const executorTools = (vi.mocked(deepseekChat).mock.calls[1]?.[3] ?? []) as ToolDefinition[]

    // 消息精简:2 条,system=执行器规则,user=文档全文+任务+方案,无历史
    expect(executorMessages).toHaveLength(2)
    expect(executorMessages[0].role).toBe('system')
    expect(String(executorMessages[0].content)).toBe(EXECUTOR_RULE)
    const userText = String(executorMessages[1].content)
    expect(userText).toContain('## 当前文档全文')
    expect(userText).toContain(DOC_BODY)
    expect(userText).toContain('## 用户任务')
    expect(userText).toContain(USER_TASK)
    expect(userText).toContain('## 既定方案')
    expect(userText).toContain(planText)
    // 不含毒上下文(历史/persona/规则段落)
    expect(userText).not.toContain('## Conversation History')
    expect(executorMessages.some((m: any) => String(m.content).includes('Context segments'))).toBe(false)

    // tools 仅写回类 — search_medical_web 被过滤
    const toolNames = executorTools.map((t: ToolDefinition) => t.function.name)
    expect(toolNames).toContain('edit_document')
    expect(toolNames).not.toContain('search_medical_web')
  })

  test('执行器二次失败 → 诚实告知 + edit_claim_unbacked 留痕(executorRetry)', async () => {
    const ctx = makeCtx(VALID_SESSION)
    const { registry, tools } = makeRegistryAndTools(ctx)

    // 主回路与执行器都输出声明文本(零写回)
    vi.mocked(deepseekChat).mockResolvedValue('已完成修改，内容已整理完毕。')

    const { io, chunks } = makeIO()
    const main = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: USER_TASK }],
      toolRegistry: registry,
      tools,
      apiKey: 'k',
      io,
      ctx,
      userId: 'user_1',
      sessionId: VALID_SESSION,
    })
    expect(main.executedWriteTools).toEqual([])

    const rescue = await runDocExecutorFallback({
      userId: 'user_1',
      sessionId: VALID_SESSION,
      userText: USER_TASK,
      planText: '方案：润色摘要',
      apiKey: 'k',
      io,
      ctx,
      toolRegistry: registry,
      tools,
    })

    expect(rescue.executedWriteTools).toEqual([])
    // 诚实告知(执行器专属文案)
    expect(chunks.some((c) => c.type === 'context_info' && String((c as any).text) === DOC_EXECUTOR_FAILED_NOTICE)).toBe(true)
    // 事件留痕:执行器留痕带 executorRetry 标记(主回路守卫也留痕一条)
    const events = ctx.eventLog.append.mock.calls.map((c: any[]) => c[0])
    const executorEvents = events.filter((e: any) => e.eventType === 'edit_claim_unbacked' && e.metadata.executorRetry)
    expect(executorEvents).toHaveLength(1)
  })

  test('doc 不存在 → 执行器直接返回,不调 LLM', async () => {
    const ctx = makeCtx(VALID_SESSION)
    const { registry, tools } = makeRegistryAndTools(ctx)
    mocks.docFindFirst.mockResolvedValue(null)

    const { io } = makeIO()
    const rescue = await runDocExecutorFallback({
      userId: 'user_1',
      sessionId: VALID_SESSION,
      userText: USER_TASK,
      planText: '方案',
      apiKey: 'k',
      io,
      ctx,
      toolRegistry: registry,
      tools,
    })

    expect(rescue.executedWriteTools).toEqual([])
    expect(deepseekChat).not.toHaveBeenCalled()
    expect(ctx.eventLog.append).not.toHaveBeenCalled()
  })

  test('docId 格式不符(伪造会话)→ 执行器直接返回', async () => {
    const ctx = makeCtx('doc-bad')
    const { registry, tools } = makeRegistryAndTools(ctx)

    const { io } = makeIO()
    const rescue = await runDocExecutorFallback({
      userId: 'user_1',
      sessionId: 'doc-bad',
      userText: USER_TASK,
      planText: '方案',
      apiKey: 'k',
      io,
      ctx,
      toolRegistry: registry,
      tools,
    })

    expect(rescue.executedWriteTools).toEqual([])
    expect(deepseekChat).not.toHaveBeenCalled()
    expect(mocks.docFindFirst).not.toHaveBeenCalled()
  })
})
