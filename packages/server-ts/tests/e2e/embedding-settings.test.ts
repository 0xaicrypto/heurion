import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getApp, authHeader } from '../setup.js'

function mockJsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GET /api/v1/settings/embedding', () => {
  test('proxies the embedding server health info', async () => {
    const app = await getApp()
    vi.stubEnv('LOCAL_EMBEDDING_URL', 'http://embedding:8003/embed')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const u = String(url)
        if (u.includes('/health')) {
          return mockJsonResponse({ status: 'ok', model: 'Xenova/bge-small-en-v1.5', dimensions: 384, device: 'cpu', quantized: false, dtype: null })
        }
        return mockJsonResponse({ error: 'not found' }, 404)
      }),
    )

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/embedding',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.ok).toBe(true)
    expect(body.model).toBe('Xenova/bge-small-en-v1.5')
    expect(body.dimensions).toBe(384)
    expect(body.device).toBe('cpu')
  })

  test('returns 502 when the embedding server is unreachable', async () => {
    const app = await getApp()
    vi.stubEnv('LOCAL_EMBEDDING_URL', 'http://embedding:8003/embed')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused') }))

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/embedding',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(502)
    expect(res.payload).toContain('unreachable')
  })
})
