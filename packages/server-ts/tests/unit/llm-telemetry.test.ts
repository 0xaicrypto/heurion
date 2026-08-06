import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { deepseekChat, setLlmTelemetryService } from '../../src/common/llm.js'
import { InMemoryTelemetryService } from '../../src/modules/knowledge/telemetry.service.js'

describe('LLM telemetry integration', () => {
  let telemetry: InMemoryTelemetryService
  let originalFetch: typeof fetch

  beforeEach(() => {
    telemetry = new InMemoryTelemetryService()
    setLlmTelemetryService(telemetry)
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    setLlmTelemetryService(undefined)
    globalThis.fetch = originalFetch
  })

  test('records llm_cost telemetry after a non-streaming call', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    }) as any

    await deepseekChat([{ role: 'user', content: 'hello' }], 'key', {
      model: 'deepseek-chat',
      telemetryContext: { userId: 'u1', workspaceId: 'u1', action: 'test.action' },
    })

    const events = await telemetry.query({ workspaceId: 'u1', category: 'llm_cost' })
    expect(events.length).toBe(1)
    expect(events[0].action).toBe('test.action')
    expect(events[0].metadata.model).toBe('deepseek-chat')
    expect(events[0].metadata.promptTokens).toBe(100)
    expect(events[0].metadata.completionTokens).toBe(20)
    expect(events[0].metadata.totalTokens).toBe(120)
    expect(typeof events[0].metadata.costUsd).toBe('number')
  })

  test('approximates tokens and still records when usage is missing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'short reply' } }],
      }),
    }) as any

    await deepseekChat([{ role: 'user', content: 'hello world' }], 'key', {
      model: 'deepseek-chat',
      telemetryContext: { userId: 'u2', workspaceId: 'u2', action: 'fallback.action' },
    })

    const events = await telemetry.query({ workspaceId: 'u2', category: 'llm_cost' })
    expect(events.length).toBe(1)
    expect(events[0].metadata.totalTokens).toBeGreaterThan(0)
    expect(typeof events[0].metadata.costUsd).toBe('number')
  })
})

describe('LLM cache usage telemetry (O3 #108)', () => {
  let telemetry: InMemoryTelemetryService
  let originalFetch: typeof fetch

  beforeEach(() => {
    telemetry = new InMemoryTelemetryService()
    setLlmTelemetryService(telemetry)
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    setLlmTelemetryService(undefined)
    globalThis.fetch = originalFetch
  })

  test('cache hit/miss tokens are captured into llm_cost metadata', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 },
      }),
    }) as any

    await deepseekChat([{ role: 'user', content: 'hello' }], 'key', {
      model: 'deepseek-chat',
      telemetryContext: { userId: 'u1', workspaceId: 'u1', action: 'test.cache' },
    })

    const events = await telemetry.query({ workspaceId: 'u1', category: 'llm_cost' })
    expect(events[0].metadata.cacheHitTokens).toBe(80)
    expect(events[0].metadata.cacheMissTokens).toBe(20)
    // 80 of 100 prompt tokens were cache hits → 80%
    expect(events[0].metadata.cacheHitPct).toBe(80)
  })
})
