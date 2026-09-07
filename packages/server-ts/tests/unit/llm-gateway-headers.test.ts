import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getLlmGateway } from '../../src/common/llm-gateway.js'

/**
 * #fix 2026-09 — OpenCode Go 会话头回归。
 * 生产 48h 内 18 次 HTTP 400 MissingSessionID:Console Go 上游强制要求
 * `x-opencode-session` 稳定会话头,gateway 此前只发 Content-Type+Authorization。
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

function okResponse(): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200 })
}

function capturedHeaders(mock: ReturnType<typeof vi.fn>): Record<string, string> {
  const init = mock.mock.calls[0][1] as RequestInit
  return init.headers as Record<string, string>
}

describe('#fix 2026-09 — OpenCode Go x-opencode-session 头', () => {
  beforeEach(() => {
    process.env.DEFAULT_LLM_PROVIDER = 'opencode'
    process.env.OPENCODE_API_KEY = 'test-key'
    delete process.env.DEFAULT_LLM_MODEL
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    process.env.DEFAULT_LLM_PROVIDER = 'deepseek'
  })

  test('opencode provider + sessionId → 头携带该会话 ID + 自报 UA', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)

    await getLlmGateway().chatWithMeta(
      [{ role: 'user', content: 'hi' }],
      { model: 'deepseek-v4-flash', sessionId: 'doc-abc123' },
    )

    const h = capturedHeaders(fetchMock)
    expect(h['x-opencode-session']).toBe('doc-abc123')
    expect(h['User-Agent']).toContain('Heurion/')
  })

  test('opencode provider 无 sessionId → 回落稳定常量(后台任务桶)', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)

    await getLlmGateway().chatWithMeta([{ role: 'user', content: 'hi' }], { model: 'deepseek-v4-flash' })

    expect(capturedHeaders(fetchMock)['x-opencode-session']).toBe('heurion-server')
  })

  test('deepseek provider → 不带该头(其他 provider 不受影响)', async () => {
    process.env.DEFAULT_LLM_PROVIDER = 'deepseek'
    process.env.DEEPSEEK_API_KEY = 'test-key'
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)

    await getLlmGateway().chatWithMeta(
      [{ role: 'user', content: 'hi' }],
      { model: 'deepseek-chat', sessionId: 'doc-abc123' },
    )

    const h = capturedHeaders(fetchMock)
    expect(h['x-opencode-session']).toBeUndefined()
    expect(h.Authorization).toBe('Bearer test-key')
  })

  test('流式路径同样携带会话头', async () => {
    const fetchMock = vi.fn(async () => sseChunks([
      { choices: [{ delta: { content: 'ok' } }] },
    ]))
    vi.stubGlobal('fetch', fetchMock)

    for await (const _ of getLlmGateway().stream(
      [{ role: 'user', content: 'hi' }],
      { model: 'deepseek-v4-flash', sessionId: 'doc-stream-1' },
    )) { void _ }

    expect(capturedHeaders(fetchMock)['x-opencode-session']).toBe('doc-stream-1')
  })
})
