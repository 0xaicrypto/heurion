import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createAiProvider,
  loadAiConfigFromEnv,
  AiProviderError,
  DeepSeekChatProvider,
  GeminiVisionProvider,
  LocalEmbeddingProvider,
  OpenAIEmbeddingProvider,
  type TelemetryRecorder,
  type AiTelemetryEvent,
} from '../src/common/ai/index.js'

function mockJsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('AI Provider configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('loads config from environment variables', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-deep')
    vi.stubEnv('GEMINI_API_KEY', 'sk-gemini')
    vi.stubEnv('EMBEDDING_PROVIDER', 'openai')
    vi.stubEnv('EMBEDDING_MODEL', 'text-embedding-custom')
    vi.stubEnv('LOCAL_EMBEDDING_URL', 'http://localhost:9999/embed')
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai')

    const cfg = loadAiConfigFromEnv()
    expect(cfg.deepseekApiKey).toBe('sk-deep')
    expect(cfg.geminiApiKey).toBe('sk-gemini')
    expect(cfg.embeddingProvider).toBe('openai')
    expect(cfg.embeddingModel).toBe('text-embedding-custom')
    expect(cfg.localEmbeddingUrl).toBe('http://localhost:9999/embed')
    expect(cfg.openaiApiKey).toBe('sk-openai')
  })

  test('uses sensible defaults when env vars are missing', () => {
    const cfg = loadAiConfigFromEnv()
    expect(cfg.deepseekChatModel).toBe('deepseek-chat')
    expect(cfg.geminiVisionModel).toBe('gemini-2.0-flash')
    expect(cfg.embeddingProvider).toBe('local')
    expect(cfg.embeddingModel).toBe('BAAI/bge-m3')
    expect(cfg.localEmbeddingUrl).toBe('http://localhost:8003/embed')
    expect(cfg.openaiEmbeddingModel).toBe('text-embedding-3-small')
  })
})

describe('DeepSeek chat provider', () => {
  beforeEach(() => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  test('returns ChatResult with usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockJsonResponse({
        choices: [{ message: { content: 'hello from deepseek' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      })),
    )

    const provider = new DeepSeekChatProvider()
    const result = await provider.chat([{ role: 'user', content: 'hi' }])

    expect(result.content).toBe('hello from deepseek')
    expect(result.model).toBe('deepseek-chat')
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 3, totalTokens: 13 })

    const calls = vi.mocked(fetch).mock.calls
    expect(calls.length).toBe(1)
    const [url, init] = calls[0]
    expect(url).toContain('deepseek.com')
    const body = JSON.parse(init?.body as string)
    expect(body.model).toBe('deepseek-chat')
  })

  test('throws config error when API key is missing', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const provider = new DeepSeekChatProvider()
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(AiProviderError)
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('DEEPSEEK_API_KEY')
  })

  test('throws api error on non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthorized', { status: 401 })),
    )
    const provider = new DeepSeekChatProvider()
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(AiProviderError)
  })

  test('retries transient 429 then succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
        .mockResolvedValueOnce(mockJsonResponse({ choices: [{ message: { content: 'recovered' } }] })),
    )
    const provider = new DeepSeekChatProvider()
    const result = await provider.chat([{ role: 'user', content: 'hi' }])
    expect(result.content).toBe('recovered')
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
  })

  test('retries 500 up to MAX_RETRIES then throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    const provider = new DeepSeekChatProvider()
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(AiProviderError)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3)
  })

  test('does not retry non-transient 400', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad request', { status: 400 })))
    const provider = new DeepSeekChatProvider()
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(AiProviderError)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  test('retries network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(mockJsonResponse({ choices: [{ message: { content: 'ok' } }] })),
    )
    const provider = new DeepSeekChatProvider()
    const result = await provider.chat([{ role: 'user', content: 'hi' }])
    expect(result.content).toBe('ok')
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
  })
})

describe('Gemini vision provider', () => {
  beforeEach(() => {
    vi.stubEnv('GEMINI_API_KEY', 'sk-gemini')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  test('returns VisionResult', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockJsonResponse({
        candidates: [{ content: { parts: [{ text: 'nodule detected' }] } }],
      })),
    )

    const provider = new GeminiVisionProvider()
    const result = await provider.vision([{ base64: 'fakebase64', mimeType: 'image/png' }], 'analyze this')

    expect(result.content).toBe('nodule detected')
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(url).toContain('generativelanguage.googleapis.com')
  })

  test('throws config error when API key is missing', async () => {
    vi.unstubAllEnvs()
    const provider = new GeminiVisionProvider()
    await expect(provider.vision([{ base64: 'x' }], 'prompt')).rejects.toThrow('GEMINI_API_KEY')
  })
})

describe('Local embedding provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('returns embeddings array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) => {
        expect(url.toString()).toBe('http://localhost:8003/embed')
        return mockJsonResponse({ embeddings: [[0.1, 0.2], [0.3, 0.4]] })
      }),
    )

    const provider = new LocalEmbeddingProvider()
    const result = await provider.embed(['hello', 'world'])
    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]])
  })

  test('throws api error on invalid response shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockJsonResponse({ embeddings: [[0.1]] })))
    const provider = new LocalEmbeddingProvider()
    await expect(provider.embed(['a', 'b'])).rejects.toThrow('Invalid embedding response shape')
  })
})

describe('OpenAI embedding provider', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  test('returns embeddings from OpenAI format', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockJsonResponse({
        data: [{ embedding: [0.9, 0.8] }, { embedding: [0.7, 0.6] }],
      })),
    )

    const provider = new OpenAIEmbeddingProvider()
    const result = await provider.embed(['foo', 'bar'])
    expect(result).toEqual([[0.9, 0.8], [0.7, 0.6]])
  })

  test('throws config error when API key is missing', async () => {
    vi.unstubAllEnvs()
    const provider = new OpenAIEmbeddingProvider()
    await expect(provider.embed(['x'])).rejects.toThrow('OPENAI_API_KEY')
  })
})

describe('Composite provider switching', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  test('switches embedding adapter based on EMBEDDING_PROVIDER', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
    vi.stubEnv('GEMINI_API_KEY', 'sk-gemini')
    vi.stubEnv('EMBEDDING_PROVIDER', 'openai')
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai')

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) => {
        const target = url.toString()
        if (target.includes('openai.com')) {
          return mockJsonResponse({ data: [{ embedding: [0.5, 0.5] }] })
        }
        return new Response('not found', { status: 404 })
      }),
    )

    const provider = createAiProvider()
    const embeddings = await provider.embed(['test'])
    expect(embeddings).toEqual([[0.5, 0.5]])

    const calls = vi.mocked(fetch).mock.calls
    expect(calls.some(([url]) => (url as string).includes('openai.com'))).toBe(true)
  })
})

describe('Telemetry wrapper', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  test('records successful chat event', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockJsonResponse({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })),
    )

    const events: any[] = []
    const recorder: TelemetryRecorder = {
      record: (event) => { events.push(event) },
    }

    const provider = createAiProvider({}, recorder)
    await provider.chat([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' })

    expect(events.length).toBe(1)
    expect(events[0].action).toBe('chat')
    expect(events[0].success).toBe(true)
    expect(events[0].model).toBe('deepseek-chat')
    expect(events[0].usage?.totalTokens).toBe(2)
    expect(events[0].latencyMs).toBeGreaterThanOrEqual(0)
  })

  test('records failed chat event', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const events: AiTelemetryEvent[] = []
    const recorder: TelemetryRecorder = {
      record: (event) => { events.push(event) },
    }

    const provider = createAiProvider({}, recorder)
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(AiProviderError)

    expect(events.length).toBe(1)
    expect(events[0].action).toBe('chat')
    expect(events[0].success).toBe(false)
    expect(events[0].errorCode).toBe('config_missing')
  })
})
