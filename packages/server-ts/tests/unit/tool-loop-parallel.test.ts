import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { runToolCallLoop, type TurnIO } from '../../src/modules/chat/tool-loop.js'
import { ToolRegistry } from '../../src/tools/tool-registry.js'
import { BaseTool, type ToolResult } from '../../src/tools/base-tool.js'
import type { ChatStreamChunk } from '@heurion/contracts'

vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'

/**
 * #829 — tool-loop: consecutive read-only tools run in PARALLEL while the
 * transcript (messages/SSE) stays in deterministic block order; every tool
 * completion emits a typed tool_result event with seq/elapsed/preview.
 */

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

/** Records peak concurrency across overlapping execute() calls. */
function makeConcurrencyProbe() {
  let active = 0
  const probe = { active, peak: 0 }
  const track = async (ms: number, out: string): Promise<ToolResult> => {
    active++
    probe.peak = Math.max(probe.peak, active)
    await new Promise((r) => setTimeout(r, ms))
    active--
    return { success: true, output: out }
  }
  return { probe, track }
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
  const io: TurnIO = {
    send: (c) => chunks.push(c),
    signal: new AbortController().signal,
  }
  return { io, chunks }
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.clearAllMocks())

describe('#829 tool-call loop — parallel read-only execution', () => {
  test('consecutive read-only tools run concurrently; results/messages stay in block order', async () => {
    const { probe, track } = makeConcurrencyProbe()
    const registry = new ToolRegistry(testCtx)
    // Re-register two READ_ONLY tools with blocking probes — true
    // concurrency shows up in the peak counter.
    const probeA = new ProbeTool(() => track(30, 'PubMed results for "a" (1):\n1. Article A'))
    Object.defineProperty(probeA, 'name', { value: 'search_medical_web' })
    registry.register(probeA)
    const probeB = new ProbeTool(() => track(30, 'PubMed results for "b" (1):\n1. Article B'))
    Object.defineProperty(probeB, 'name', { value: 'fetch_article_summary' })
    registry.register(probeB)

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(
        '<tool_call>{"name":"search_medical_web","arguments":{"query":"a"}}</tool_call>' +
        '<tool_call>{"name":"fetch_article_summary","arguments":{"pmid":"1"}}</tool_call>',
      )
      .mockResolvedValueOnce('Final answer synthesizing both results.')

    const { io, chunks } = makeIO()
    const { finalContent, messages } = await runToolCallLoop({
      currentMessages: [{ role: 'user', content: 'research' }],
      toolRegistry: registry,
      tools: [],
      apiKey: 'k',
      io,
      ctx: testCtx,
      userId: 'user_1',
      sessionId: 'sess_1',
    })

    expect(finalContent).toContain('Final answer')
    expect(probe.peak).toBe(2) // both ran in parallel

    // SSE: two tool_call chips with distinct seqs, both running; then two
    // tool_result events closing them in ORDER.
    const calls = chunks.filter((c) => c.type === 'tool_call')
    const results = chunks.filter((c) => c.type === 'tool_result')
    expect(calls.map((c) => (c as any).seq)).toEqual([1, 2])
    expect(results.map((c) => (c as any).seq)).toEqual([1, 2])
    expect(results.every((c) => (c as any).success)).toBe(true)
    expect(results.every((c) => typeof (c as any).elapsed_ms === 'number')).toBe(true)
    // preview = output first line (#829 contract: ≤80 chars).
    expect((results[0] as any).preview).toContain('PubMed results for "a"')

    // Transcript order is deterministic: search result before fetch result.
    const toolMsgs = messages.filter((m) => m.role === 'user' && String(m.content).startsWith('Tool "'))
    expect(String(toolMsgs[0].content)).toContain('search_medical_web')
    expect(String(toolMsgs[0].content)).toContain('Article A')
    expect(String(toolMsgs[1].content)).toContain('fetch_article_summary')
    expect(String(toolMsgs[1].content)).toContain('Article B')
  })

  test('a write tool between read-only calls splits the parallel groups', async () => {
    const { probe, track } = makeConcurrencyProbe()
    const registry = new ToolRegistry(testCtx)
    registry.register(new ProbeTool(() => track(20, 'ok-a')))
    const writeTool = new ProbeTool(() => track(20, 'written'))
    Object.defineProperty(writeTool, 'name', { value: 'edit_document' })
    registry.register(writeTool)
    const readB = new ProbeTool(() => track(20, 'ok-b'))
    Object.defineProperty(readB, 'name', { value: 'search_medical_web' })
    registry.register(readB)

    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(
        '<tool_call>{"name":"edit_document","arguments":{}}</tool_call>' +
        '<tool_call>{"name":"search_medical_web","arguments":{"query":"b"}}</tool_call>',
      )
      .mockResolvedValueOnce('done')

    const { io } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: 'x' }],
      toolRegistry: registry,
      tools: [],
      apiKey: 'k',
      io,
      ctx: testCtx,
      userId: 'user_1',
      sessionId: 'sess_1',
    })
    // edit_document is serial; the single read-only call never overlaps —
    // peak stays 1.
    expect(probe.peak).toBe(1)
  })

  test('malformed JSON in one block does not abort sibling calls', async () => {
    const registry = new ToolRegistry(testCtx)
    registry.register(new ProbeTool(() => Promise.resolve({ success: true, output: 'ok' })))
    vi.mocked(deepseekChat)
      .mockResolvedValueOnce(
        '<tool_call>{"name":"search_medical_web" BROKEN</tool_call>' +
        '<tool_call>{"name":"search_medical_web","arguments":{"query":"ok"}}</tool_call>',
      )
      .mockResolvedValueOnce('final')

    const { io, chunks } = makeIO()
    await runToolCallLoop({
      currentMessages: [{ role: 'user', content: 'x' }],
      toolRegistry: registry,
      tools: [],
      apiKey: 'k',
      io,
      ctx: testCtx,
      userId: 'user_1',
      sessionId: 'sess_1',
    })
    const results = chunks.filter((c) => c.type === 'tool_result')
    expect(results).toHaveLength(1)
    expect((results[0] as any).seq).toBe(1) // only the valid call executed
  })
})
