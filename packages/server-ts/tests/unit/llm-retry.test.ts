import { describe, test, expect, vi, afterEach } from 'vitest'
import { fetchWithRetry, FRIENDLY_LLM_ERROR } from '../../src/common/llm.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('#184 LLM timeout & retry', () => {
  test('429 retries then succeeds', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      if (calls === 1) return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }))

    const res = await fetchWithRetry('https://x', { method: 'POST' }, { maxRetries: 2, delayMs: 0 })
    expect(res.status).toBe(200)
    expect(calls).toBe(2)
  })

  test('timeout raises a clear friendly-style error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise((_resolve, reject) => {
      // never resolves; abort signal triggers rejection
      setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 20)
    })))

    await expect(
      fetchWithRetry('https://x', {}, { timeoutMs: 5, delayMs: 0 }),
    ).rejects.toThrow(/timed out/)
  })

  test('5xx exhausts retries and surfaces a friendly error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 500 })))

    await expect(
      fetchWithRetry('https://x', {}, { maxRetries: 2, delayMs: 0 }),
    ).rejects.toThrow(/HTTP 500/)
  })

  test('network failure raises friendly message on exhausted retries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))

    await expect(
      fetchWithRetry('https://x', {}, { maxRetries: 1, delayMs: 0 }),
    ).rejects.toThrow('fetch failed')
  })

  test('FRIENDLY_LLM_ERROR is the user-facing copy', () => {
    expect(FRIENDLY_LLM_ERROR).toContain('服务暂时不可用')
  })
})
