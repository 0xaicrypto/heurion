import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { runToolCallLoop, type TurnIO } from '../../src/modules/chat/tool-loop.js'
import { ToolRegistry } from '../../src/tools/tool-registry.js'
import { BaseTool, type ToolResult } from '../../src/tools/base-tool.js'
import type { ChatStreamChunk } from '@heurion/contracts'

vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'

/**
 * #408-followup — render_scene presenter: the SVG URL from the tool output
 * becomes a chart_created SSE (live <img> in chat) instead of relying on the
 * model echoing the markdown into its final answer.
 */

const LT = String.fromCharCode(60)
const callBlock = (json: string) => LT + 'tool_call' + '>' + json + LT + '/tool_call' + '>'

const makeCtx = (): any => ({
  userId: 'user_scene',
  sessionId: 'sess_scene',
  isPluginInstalled: async () => true,
  eventLog: { append: vi.fn(), query: () => [], count: () => 0 },
  memory: { graph: { getAllNodes: () => [] } },
  facts: { all: () => [] },
  episodes: { all: () => [] },
  skills: { all: () => [] },
  knowledge: { all: () => [] },
})

const SCENE_OUTPUT = JSON.stringify({
  file_id: 'scene_test_1.svg',
  url: '/api/v1/files/download/scene_test_1.svg?token=t',
  markdown: '![TKI 耐药机制](/api/v1/files/download/scene_test_1.svg?token=t)',
  objects: 3,
})

class SceneToolStub extends BaseTool {
  constructor(private output: string) { super() }
  get name(): string { return 'render_scene' }
  get description(): string { return 'render_scene' }
  get parameters(): Record<string, unknown> { return { type: 'object', properties: {} } }
  async execute(): Promise<ToolResult> { return { success: true, output: this.output } }
}

function makeIO() {
  const chunks: ChatStreamChunk[] = []
  const io: TurnIO = { send: (c) => chunks.push(c), signal: new AbortController().signal }
  return { io, chunks }
}

async function runSceneTool(output: string) {
  const ctx = makeCtx()
  const registry = new ToolRegistry(ctx)
  registry.register(new SceneToolStub(output))

  vi.mocked(deepseekChat)
    .mockResolvedValueOnce(callBlock('{"name":"render_scene","arguments":{"title":"TKI 耐药机制"}}') as never)
    .mockResolvedValueOnce('示意图已生成。') as never

  const { io, chunks } = makeIO()
  await runToolCallLoop({
    currentMessages: [{ role: 'user', content: '示意 TKI 耐药机制' }],
    toolRegistry: registry, tools: [], apiKey: 'k', io, ctx,
    userId: 'user_scene', sessionId: 'sess_scene',
  })
  return chunks
}

describe('#408-followup — render_scene 输出投影为 chart_created', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('成功输出 url → chart_created(url/markdown/chart_type=scene)', async () => {
    const chunks = await runSceneTool(SCENE_OUTPUT)
    const created = chunks.find((c) => c.type === 'chart_created') as
      | { url?: string; markdown?: string; chart_type?: string }
      | undefined
    expect(created).toBeTruthy()
    expect(created!.url).toBe('/api/v1/files/download/scene_test_1.svg?token=t')
    expect(created!.markdown).toContain('![TKI 耐药机制]')
    expect(created!.chart_type).toBe('scene')
  })

  test('Reactome 模式(pathway_id)→ chart_type=reactome', async () => {
    const chunks = await runSceneTool(JSON.stringify({
      file_id: 'scene_pathway.svg',
      url: '/api/v1/files/download/scene_pathway.svg?token=t',
      pathway_id: 'R-HSA-177929',
      pathway_name: 'EGFR signaling',
      markdown: '![EGFR](/api/v1/files/download/scene_pathway.svg?token=t)',
    }))
    const created = chunks.find((c) => c.type === 'chart_created') as { chart_type?: string } | undefined
    expect(created).toBeTruthy()
    expect(created!.chart_type).toBe('reactome')
  })

  test('输出无 url → 不发 chart_created', async () => {
    const chunks = await runSceneTool(JSON.stringify({ error: 'unavailable' }))
    expect(chunks.some((c) => c.type === 'chart_created')).toBe(false)
  })
})
