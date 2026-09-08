import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getLlmGateway, setLlmGatewayForTest } from '../../src/common/llm-gateway.js'

/**
 * #fix 2026-09 — chatWithToolsStream: 工具回合流式调用。
 * 中转站模式下非流式 = 零字节直到完整生成 → CF ~100s 掐断 + 600s TTFB
 * 超时双重杀死。流式让字节持续流动,tool_calls delta 增量累积。
 */

function sseChunks(parts: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(encoder.encode(`data: ${JSON.stringify(p)}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

const TOOLS = [
  { type: 'function', function: { name: 'edit_document', description: 'edit', parameters: { type: 'object', properties: {} } } },
]

describe('chatWithToolsStream — tool_calls 增量累积', () => {
  beforeEach(() => {
    process.env.DEFAULT_LLM_PROVIDER = 'opencode'
    process.env.OPENCODE_API_KEY = 'test-key'
    process.env.DEFAULT_LLM_MODEL = 'glm-5.3-flash'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    process.env.DEFAULT_LLM_PROVIDER = 'deepseek'
  })

  test('分片 tool_calls(跨 delta 的 name/arguments)→ 拼成 tool_call 块文本 + toolCalls', async () => {
    const fetchMock = vi.fn(async () => sseChunks([
      { choices: [{ delta: { reasoning_content: '先分析文档结构' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'edit_document', arguments: '{"full_te' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'xt":"# 全文重写"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const reasoning: string[] = []
    const r = await getLlmGateway().chatWithToolsStream(
      [{ role: 'user', content: '重组文档' }],
      { sessionId: 'doc-x' },
      TOOLS,
      (t) => reasoning.push(t),
    )

    expect(reasoning).toEqual(['先分析文档结构'])
    // 与 parseChatResponse 同构的块格式 — tool-loop 零变更
    expect(r.text).toContain('edit_document')
    expect(r.text).toContain('全文重写')
    expect(r.toolCalls).toEqual([{ name: 'edit_document', arguments: '{"full_text":"# 全文重写"}' }])
    expect(r.truncated).toBe(false)

    // 请求体: stream:true + tools + 会话头
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(String(init.body))
    expect(body.stream).toBe(true)
    expect(body.tools).toHaveLength(1)
    expect((init.headers as Record<string, string>)['x-opencode-session']).toBe('doc-x')
  })

  test('finish_reason=stop + 纯 content → 正常文本返回(无 toolCalls)', async () => {
    const fetchMock = vi.fn(async () => sseChunks([
      { choices: [{ delta: { content: '直接回答' } }, { delta: {}, finish_reason: 'stop' }] },
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const r = await getLlmGateway().chatWithToolsStream([{ role: 'user', content: 'hi' }], {}, TOOLS)
    expect(r.text).toBe('直接回答')
    expect(r.toolCalls).toBeUndefined()
  })

  test('finish_reason=length → truncated 标记(纯思考截断不再自动重试后仍返回)', async () => {
    const fetchMock = vi.fn(async () => sseChunks([
      { choices: [{ delta: { reasoning_content: '思考被切断' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const r = await getLlmGateway().chatWithToolsStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-v4-flash' }, TOOLS)
    expect(r.truncated).toBe(true)
    expect(r.text).toBe('')
  })
})
