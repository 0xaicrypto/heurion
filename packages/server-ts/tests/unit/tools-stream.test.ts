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

  // #fix 2026-09-09: GLM 经 opencode 中转站发 delta.tool_calls 时
  // finish_reason 常为 null/stop — 生产实证模型逐条发出 12 个
  // edit_document 全被 finish_reason 门丢弃。回归锁:只要有工具调用
  // 增量就必须转换,finish_reason 仅供日志。
  test('finish_reason=null + delta.tool_calls → 块照常返回(生产事故回归锁)', async () => {
    const fetchMock = vi.fn(async () => sseChunks([
      { choices: [{ delta: { reasoning_content: '逐条整理' } }] },
      { choices: [{ delta: { content: '我将逐条整理参考文献：' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'edit_document', arguments: '{"old_text":"[1]","new_text":"1."}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'edit_document', arguments: '{"old_text":"[2]","new_text":"2."}' } }] } }] },
      { usage: { prompt_tokens: 8664, completion_tokens: 13262, total_tokens: 21926 } },
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const r = await getLlmGateway().chatWithToolsStream([{ role: 'user', content: '整理参考文献' }], {}, TOOLS)
    expect(r.toolCalls).toHaveLength(2)
    expect(r.text).toContain('我将逐条整理参考文献')
    expect((r.text?.match(/edit_document/g) || []).length).toBe(2)
    expect(r.truncated).toBe(false)
  })

  test('finish_reason=stop + delta.tool_calls + 引导语 → 引导语保留 + 块返回', async () => {
    const fetchMock = vi.fn(async () => sseChunks([
      { choices: [{ delta: { content: '直接执行编辑：' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'edit_document', arguments: '{"old_text":"A","new_text":"B"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const r = await getLlmGateway().chatWithToolsStream([{ role: 'user', content: '改' }], {}, TOOLS)
    expect(r.toolCalls).toHaveLength(1)
    expect(r.text).toContain('直接执行编辑：')
    expect(r.text).toContain('edit_document')
  })
})
describe('#979 — index 缺失的 delta 归属（GLM/opencode 中转生产形态）', () => {
  beforeEach(() => {
    process.env.DEFAULT_LLM_PROVIDER = 'opencode'
    process.env.OPENCODE_API_KEY = 'test-key'
    process.env.DEFAULT_LLM_MODEL = 'glm-5.3-flash'
  })

  test('name 与 arguments 分处无 index 的不同 delta → 参数不再碎片化丢失', async () => {
    // 生产实例形态:name 在首个 delta(无 index),后续每个 arguments 增量
    // 均无 index — 旧逻辑「无 index 一律 toolAcc.size」把增量开成无名新
    // 条目再丢弃 → edit_document({}) 空参。
    const fetchMock = vi.fn(async () => sseChunks([
      { choices: [{ delta: { tool_calls: [{ id: 'call_a', function: { name: 'edit_document', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ function: { arguments: '{"old_text":"第三段",\n' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ function: { arguments: '"new_text":"内容"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const r = await getLlmGateway().chatWithToolsStream(
      [{ role: 'user', content: '继续第三步' }], { sessionId: 'doc-x' }, TOOLS,
    )

    // 一个工具调用,参数完整(不再是 {})
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls![0].name).toBe('edit_document')
    const parsed = JSON.parse(r.toolCalls![0].arguments)
    expect(parsed).toEqual({ old_text: '第三段', new_text: '内容' })
    expect(r.text).toContain('"old_text"')
  })

  test('多个无 index 工具调用(以 id 分界)→ 各自归位', async () => {
    const fetchMock = vi.fn(async () => sseChunks([
      { choices: [{ delta: { tool_calls: [{ id: 'c1', function: { name: 'edit_document', arguments: '{"old_text":"a"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: 'c2', function: { name: 'edit_document', arguments: '{"old_text":"b"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const r = await getLlmGateway().chatWithToolsStream(
      [{ role: 'user', content: '逐节填充' }], { sessionId: 'doc-x' }, TOOLS,
    )
    expect(r.toolCalls).toHaveLength(2)
    expect(JSON.parse(r.toolCalls![0].arguments)).toEqual({ old_text: 'a' })
    expect(JSON.parse(r.toolCalls![1].arguments)).toEqual({ old_text: 'b' })
  })
})
describe('#979 流式退化检测 — argsFrags=0 → 非流式重取完整 tool_calls', () => {
  beforeEach(() => {
    process.env.DEFAULT_LLM_PROVIDER = 'opencode'
    process.env.OPENCODE_API_KEY = 'test-key'
    process.env.DEFAULT_LLM_MODEL = 'glm-5.3-flash'
  })

  test('流式增量 0 参数字节（中转丢参生产形态）→ 非流式重取,工具收到完整参数', async () => {
    // 第 1 次 fetch:流式增量只有 name,参数字节为 0（生产实锤形态）
    // 第 2 次 fetch（非流式降级）:完整 tool_calls
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => sseChunks([
        { choices: [{ delta: { tool_calls: [{ id: 'call_x', function: { name: 'edit_document', arguments: '' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: {} } ] } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ]))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'edit_document', arguments: '{"old_text":"第三段原文","new_text":"Third section"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const r = await getLlmGateway().chatWithToolsStream(
      [{ role: 'user', content: '继续第三步' }], { sessionId: 'doc-x' }, TOOLS,
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    // 最终输出 = 完整参数的 tool_call 块（工具不再收到 {}）
    expect(r.text).toContain('edit_document')
    expect(r.text).toContain('old_text')
    expect(r.text).not.toContain('"arguments":{}')
  })
})
