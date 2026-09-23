import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { runToolCallLoop, type TurnIO } from '../../src/modules/chat/tool-loop.js'
import { ToolRegistry } from '../../src/tools/tool-registry.js'
import { BaseTool, type ToolResult } from '../../src/tools/base-tool.js'
import { buildBlockProjection } from '../../src/lib/block-projection.js'
import type { ChatStreamChunk } from '@heurion/contracts'

vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'

/**
 * #989 Phase 3 — doc_updated SSE 携带块级结构投影:
 * 工具输出 JSON.projection → presenter 校验(blockProjectionSchema)后随
 * doc_updated 推前端;损坏形状降级为不携带(前端按无投影处理)。
 */

// 运行时构造 tool-call 文本协议标记(避免测试源码出现可执行协议明文)。
const LT = String.fromCharCode(60)
const callBlock = (json: string) => LT + 'tool_call' + '>' + json + LT + '/tool_call' + '>'

const makeCtx = (sessionId: string): any => ({
  userId: 'user_docupd',
  sessionId,
  eventLog: { append: vi.fn(), query: () => [], count: () => 0 },
  memory: { graph: { getAllNodes: () => [] } },
  facts: { all: () => [] },
  episodes: { all: () => [] },
  skills: { all: () => [] },
  knowledge: { all: () => [] },
})

const BODY = '# T\n\n## Intro\nintro text.'

class WriteTool extends BaseTool {
  constructor(private output: string) { super() }
  get name(): string { return 'edit_document' }
  get description(): string { return 'edit_document' }
  get parameters(): Record<string, unknown> { return { type: 'object', properties: {} } }
  async execute(): Promise<ToolResult> {
    return { success: true, output: this.output }
  }
}

function makeIO() {
  const chunks: ChatStreamChunk[] = []
  const io: TurnIO = { send: (c) => chunks.push(c), signal: new AbortController().signal }
  return { io, chunks }
}

beforeEach(() => { vi.clearAllMocks() })

describe('#989 Phase 3 — doc_updated 携带块投影(presenter 接线)', () => {
  test('工具输出 JSON.projection → doc_updated.projection(schema 校验通过)', async () => {
    const projection = buildBlockProjection(BODY)
    const ctx = makeCtx('doc-docupd1')
    const registry = new ToolRegistry(ctx)
    registry.register(new WriteTool(JSON.stringify({ body: BODY, summary: '已写入', projection })))

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"edit_document","arguments":{"old_text":"a","new_text":"x"}}' as never))
      .mockResolvedValueOnce('第一节已写入。') as never

    const { io, chunks } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '编辑' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_docupd1', sessionId: 'doc-docupd1',
    })

    const docUpdated = chunks.find((c) => c.type === 'doc_updated') as { projection?: unknown } | undefined
    expect(docUpdated).toBeTruthy()
    expect(docUpdated!.projection).toEqual(projection)
  })

  test('损坏投影(缺 body_hash)→ 降级为不携带(前端按无投影处理)', async () => {
    const ctx = makeCtx('doc-docupd2')
    const registry = new ToolRegistry(ctx)
    registry.register(new WriteTool(JSON.stringify({
      body: BODY, summary: '已写入',
      projection: { schema_version: 1, nodes: [] }, // 缺 body_hash — schema 拒绝
    })))

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"edit_document","arguments":{"old_text":"a","new_text":"x"}}' as never))
      .mockResolvedValueOnce('完成。') as never

    const { io, chunks } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '编辑' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_docupd2', sessionId: 'doc-docupd2',
    })

    const docUpdated = chunks.find((c) => c.type === 'doc_updated') as { projection?: unknown } | undefined
    expect(docUpdated).toBeTruthy()
    expect(docUpdated!.projection).toBeUndefined()
  })

  test('工具输出无 projection(旧形态)→ doc_updated 无该字段(向后兼容)', async () => {
    const ctx = makeCtx('doc-docupd3')
    const registry = new ToolRegistry(ctx)
    registry.register(new WriteTool(JSON.stringify({ body: BODY, summary: '已写入' })))

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"edit_document","arguments":{"old_text":"a","new_text":"x"}}' as never))
      .mockResolvedValueOnce('完成。') as never

    const { io, chunks } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '编辑' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_docupd3', sessionId: 'doc-docupd3',
    })

    const docUpdated = chunks.find((c) => c.type === 'doc_updated') as { projection?: unknown } | undefined
    expect(docUpdated).toBeTruthy()
    expect(docUpdated!.projection).toBeUndefined()
  })

  test('工具输出 changedSections → doc_updated.changed_sections(改动日志全路径)', async () => {
    const projection = buildBlockProjection(BODY)
    const sections = projection.nodes
      .filter((n) => n.kind === 'section')
      .map((n) => ({ id: n.id, heading: n.heading || '' }))
    const ctx = makeCtx('doc-docupd4')
    const registry = new ToolRegistry(ctx)
    registry.register(new WriteTool(JSON.stringify({ body: BODY, summary: '已写入', projection, changedSections: sections })))

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"edit_document","arguments":{"old_text":"a","new_text":"x"}}' as never))
      .mockResolvedValueOnce('完成。') as never

    const { io, chunks } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '编辑' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_docupd4', sessionId: 'doc-docupd4',
    })

    const docUpdated = chunks.find((c) => c.type === 'doc_updated') as { changed_sections?: unknown } | undefined
    expect(docUpdated).toBeTruthy()
    expect(docUpdated!.changed_sections).toEqual(sections)
  })

  test('changedSections 形状损坏(非字符串 id)→ 降级为不携带', async () => {
    const ctx = makeCtx('doc-docupd5')
    const registry = new ToolRegistry(ctx)
    registry.register(new WriteTool(JSON.stringify({ body: BODY, summary: '已写入', changedSections: [{ id: 42 }, null, 'x'] })))

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"edit_document","arguments":{"old_text":"a","new_text":"x"}}' as never))
      .mockResolvedValueOnce('完成。') as never

    const { io, chunks } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '编辑' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_docupd5', sessionId: 'doc-docupd5',
    })

    const docUpdated = chunks.find((c) => c.type === 'doc_updated') as { changed_sections?: unknown } | undefined
    expect(docUpdated).toBeTruthy()
    expect(docUpdated!.changed_sections).toBeUndefined()
  })

  test('#1113 工具输出 artifact_id/version → doc_updated.deck_version(画布实时刷新)', async () => {
    const ctx = makeCtx('doc-docupd7')
    const registry = new ToolRegistry(ctx)
    registry.register(new WriteTool(JSON.stringify({
      body: BODY, summary: 'deck 已更新',
      artifact_id: 'deck-d1-1700000000000.pptx', version: 'deck-d1-1700000000000.pptx',
    })))

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"edit_document","arguments":{"old_text":"a","new_text":"x"}}' as never))
      .mockResolvedValueOnce('完成。') as never

    const { io, chunks } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '改 deck' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_docupd7', sessionId: 'doc-docupd7',
    })

    const docUpdated = chunks.find((c) => c.type === 'doc_updated') as { deck_version?: string } | undefined
    expect(docUpdated).toBeTruthy()
    expect(docUpdated!.deck_version).toBe('deck-d1-1700000000000.pptx')
  })

  test('#1113 无 artifact 字段的写回 → 不携带 deck_version(向后兼容)', async () => {
    const ctx = makeCtx('doc-docupd8')
    const registry = new ToolRegistry(ctx)
    registry.register(new WriteTool(JSON.stringify({ body: BODY, summary: '已写入' })))

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"edit_document","arguments":{"old_text":"a","new_text":"x"}}' as never))
      .mockResolvedValueOnce('完成。') as never

    const { io, chunks } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '编辑' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_docupd8', sessionId: 'doc-docupd8',
    })

    const docUpdated = chunks.find((c) => c.type === 'doc_updated') as { deck_version?: unknown } | undefined
    expect(docUpdated).toBeTruthy()
    expect(docUpdated!.deck_version).toBeUndefined()
  })

  test('#408-followup 工具输出 title → doc_updated.title(改名与正文同帧透传)', async () => {
    const ctx = makeCtx('doc-docupd6')
    const registry = new ToolRegistry(ctx)
    registry.register(new WriteTool(JSON.stringify({ body: BODY, summary: '改名', title: '新标题' })))

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(callBlock('{"name":"edit_document","arguments":{"title":"新标题","old_text":"a","new_text":"x"}}' as never))
      .mockResolvedValueOnce('完成。') as never

    const { io, chunks } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: '改标题' }],
      toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
      userId: 'user_docupd6', sessionId: 'doc-docupd6',
    })

    const docUpdated = chunks.find((c) => c.type === 'doc_updated') as { title?: string } | undefined
    expect(docUpdated).toBeTruthy()
    expect(docUpdated!.title).toBe('新标题')
  })
})
