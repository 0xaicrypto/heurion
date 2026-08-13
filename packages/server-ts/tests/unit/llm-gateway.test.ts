import { describe, test, expect, vi, beforeAll, afterEach } from 'vitest'
import {
  getLlmGateway,
  LlmTruncatedError,
  resolveDefaultMaxTokens,
} from '../../src/common/llm-gateway.js'

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

beforeAll(() => {
  process.env.DEFAULT_LLM_PROVIDER = 'deepseek'
  process.env.DEEPSEEK_API_KEY = 'test-key'
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('#548 — LLM 输出截断检测', () => {
  test('chatWithMeta marks truncated when finish_reason=length', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '这是一句说到一半的' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 4096, total_tokens: 4106 },
    }), { status: 200 })))

    const r = await getLlmGateway().chatWithMeta([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' })
    expect(r.text).toBe('这是一句说到一半的')
    expect(r.truncated).toBe(true)
  })

  test('chatWithMeta not truncated on normal stop', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '完整回答' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200 })))

    const r = await getLlmGateway().chatWithMeta([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' })
    expect(r.truncated).toBe(false)
  })

  test('chat() stays string-typed and backward compatible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '完整回答' }, finish_reason: 'stop' }],
    }), { status: 200 })))

    const text = await getLlmGateway().chat([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' })
    expect(typeof text).toBe('string')
    expect(text).toBe('完整回答')
  })

  test('tool-call finish_reason still returns the tool block', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: { tool_calls: [{ type: 'function', function: { name: 'search_node', arguments: '{"q":"x"}' } }] },
        finish_reason: 'tool_calls',
      }],
    }), { status: 200 })))

    const text = await getLlmGateway().chat([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' })
    expect(text).toContain('<tool_call>')
  })

  test('default max_tokens comes from MAX_OUTPUT_TOKENS env instead of hardcoded 4096', async () => {
    const old = process.env.MAX_OUTPUT_TOKENS
    process.env.MAX_OUTPUT_TOKENS = '12000'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await getLlmGateway().chat([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' })
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.max_tokens).toBe(12000)

    if (old === undefined) delete process.env.MAX_OUTPUT_TOKENS
    else process.env.MAX_OUTPUT_TOKENS = old
  })

  test('default max_tokens matches the CHOSEN model capability (env override absent)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }), { status: 200 })))

    await getLlmGateway().chat([{ role: 'user', content: 'hi' }], { model: 'gemini-2.5-flash' })
    await getLlmGateway().chat([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' })
    await getLlmGateway().chat([{ role: 'user', content: 'hi' }], { model: 'gpt-4o-mini' })

    const bodies = (vi.mocked(fetch).mock.calls as Array<[string, RequestInit]>).map((c) => JSON.parse(c[1].body as string))
    expect(bodies[0].model).toBe('gemini-2.5-flash')
    expect(bodies[0].max_tokens).toBe(8192)
    expect(bodies[1].max_tokens).toBe(8192)
    expect(bodies[2].max_tokens).toBe(16384)
  })

  test('resolveDefaultMaxTokens: 模型能力 > env 兜底 > 4096 安全默认', () => {
    const old = process.env.MAX_OUTPUT_TOKENS
    delete process.env.MAX_OUTPUT_TOKENS
    expect(resolveDefaultMaxTokens('deepseek-chat')).toBe(8192)
    expect(resolveDefaultMaxTokens('deepseek-v4-flash')).toBe(384000)
    expect(resolveDefaultMaxTokens('deepseek-v4-pro')).toBe(384000)
    expect(resolveDefaultMaxTokens('gemini-2.5-pro')).toBe(65536)
    expect(resolveDefaultMaxTokens('unknown-model-xyz')).toBe(4096)
    process.env.MAX_OUTPUT_TOKENS = '20000'
    expect(resolveDefaultMaxTokens('deepseek-chat')).toBe(20000)
    expect(resolveDefaultMaxTokens('unknown-model-xyz')).toBe(20000)
    if (old === undefined) delete process.env.MAX_OUTPUT_TOKENS
    else process.env.MAX_OUTPUT_TOKENS = old
  })

  test('explicit maxTokens option still wins', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await getLlmGateway().chat([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat', maxTokens: 2048 })
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.max_tokens).toBe(2048)
  })

  test('stream throws LlmTruncatedError when finish_reason=length, keeping already yielded chunks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseChunks([
      { choices: [{ delta: { content: 'partial ' } }] },
      { choices: [{ delta: { content: 'answer' }, finish_reason: 'length' }] },
    ])))

    const chunks: string[] = []
    const run = (async () => {
      for await (const c of getLlmGateway().stream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' })) {
        chunks.push(c)
      }
    })()
    await expect(run).rejects.toThrow(LlmTruncatedError)
    expect(chunks.join('')).toBe('partial answer')
  })

  test('stream completes normally when finish_reason=stop', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseChunks([
      { choices: [{ delta: { content: 'hello ' } }] },
      { choices: [{ delta: { content: 'world' } }, { finish_reason: 'stop' }] },
    ])))

    let out = ''
    for await (const c of getLlmGateway().stream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' })) {
      out += c
    }
    expect(out).toBe('hello world')
  })
})

describe('#548 — 推理阶段截断自动重试（绝不能零正文中断）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  const stopResponse = (content: string) => new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200 })

  test('非流式:纯推理截断(空正文+length)→ 自动重试一次并返回正文', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '', reasoning_content: 'long thinking...' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 4096, total_tokens: 4106 },
      }), { status: 200 }))
      .mockResolvedValueOnce(stopResponse('最终回答'))
    vi.stubGlobal('fetch', fetchMock)

    const r = await getLlmGateway().chatWithMeta([{ role: 'user', content: '复杂问题' }], { model: 'deepseek-reasoner' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(r.text).toBe('最终回答')
    expect(r.truncated).toBe(false)
  })

  test('非流式:重试后仍纯推理截断 → 返回 empty text + truncated,不无限重试', async () => {
    const truncated = () => new Response(JSON.stringify({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
    }), { status: 200 })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(truncated())
      .mockResolvedValueOnce(truncated())
    vi.stubGlobal('fetch', fetchMock)

    const r = await getLlmGateway().chatWithMeta([{ role: 'user', content: '复杂问题' }], { model: 'deepseek-reasoner' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(r.text).toBe('')
    expect(r.truncated).toBe(true)
  })

  test('非流式:已有正文的截断 → 不重试,直接返回 truncated', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '半截正文' }, finish_reason: 'length' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const r = await getLlmGateway().chatWithMeta([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r.text).toBe('半截正文')
    expect(r.truncated).toBe(true)
  })

  test('流式:纯推理截断(有 reasoning 无 content)→ 自动重试,只产出重试轮正文', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseChunks([
        { choices: [{ delta: { reasoning_content: 'thinking hard...' } }] },
        { choices: [{ delta: { content: '' }, finish_reason: 'length' }] },
      ]))
      .mockResolvedValueOnce(sseChunks([
        { choices: [{ delta: { content: '重试后的正文' } }, { finish_reason: 'stop' }] },
      ]))
    vi.stubGlobal('fetch', fetchMock)

    const sawReasoning: string[] = []
    const chunks: string[] = []
    for await (const c of getLlmGateway().stream(
      [{ role: 'user', content: '复杂问题' }],
      { model: 'deepseek-reasoner' },
      (t) => sawReasoning.push(t),
    )) {
      chunks.push(c)
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sawReasoning.join('')).toContain('thinking hard')
    expect(chunks.join('')).toBe('重试后的正文')
  })

  test('流式:重试仍无正文截断 → 抛 LlmTruncatedError(hadContent=false, hadReasoning=true)', async () => {
    const truncated = () => sseChunks([
      { choices: [{ delta: { reasoning_content: 'still thinking...' } }] },
      { choices: [{ delta: { content: '' }, finish_reason: 'length' }] },
    ])
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(truncated())
      .mockResolvedValueOnce(truncated())
    vi.stubGlobal('fetch', fetchMock)

    const run = (async () => {
      for await (const _c of getLlmGateway().stream([{ role: 'user', content: '复杂问题' }], { model: 'deepseek-reasoner' })) { /* noop */ }
    })()
    await expect(run).rejects.toThrow(LlmTruncatedError)
    try {
      await run
    } catch (e) {
      expect((e as LlmTruncatedError).hadContent).toBe(false)
      expect((e as LlmTruncatedError).hadReasoning).toBe(true)
    }
  })

  test('流式:已有正文仍截断 → 抛 LlmTruncatedError(hadContent=true),不重试', async () => {
    const fetchMock = vi.fn(async () => sseChunks([
      { choices: [{ delta: { content: '半截正文' }, finish_reason: 'length' }] },
    ]))
    vi.stubGlobal('fetch', fetchMock)

    try {
      for await (const _c of getLlmGateway().stream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' })) { /* noop */ }
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmTruncatedError)
      expect((e as LlmTruncatedError).hadContent).toBe(true)
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('自动重试时 max_tokens 翻倍（腾出思考空间）', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '', reasoning_content: 'x' }, finish_reason: 'length' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(stopResponse('ok'))
    vi.stubGlobal('fetch', fetchMock)

    await getLlmGateway().chatWithMeta([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat', maxTokens: 1000 })
    const bodies = (fetchMock.mock.calls as Array<[string, RequestInit]>).map((c) => JSON.parse(c[1].body as string))
    expect(bodies[0].max_tokens).toBe(1000)
    expect(bodies[1].max_tokens).toBe(2000)
  })

  test('重试预算翻倍但不超过模型输出上限', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '', reasoning_content: 'x' }, finish_reason: 'length' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(stopResponse('ok'))
    vi.stubGlobal('fetch', fetchMock)

    // Default budget for deepseek-chat is 8192 — doubling would give 16384,
    // which exceeds the model ceiling; the retry must stay at 8192.
    await getLlmGateway().chatWithMeta([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' })
    const bodies = (fetchMock.mock.calls as Array<[string, RequestInit]>).map((c) => JSON.parse(c[1].body as string))
    expect(bodies[0].max_tokens).toBe(8192)
    expect(bodies[1].max_tokens).toBe(8192)
  })
})