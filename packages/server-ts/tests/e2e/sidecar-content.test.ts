import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader } from '../setup.js'

// Execution-plane env must exist BEFORE the module under test loads (it
// snapshots WORKER_URL at import time) — vi.hoisted runs first.
vi.hoisted(() => {
  process.env.EXECUTION_PLANE_URL = 'http://localhost:9999'
  process.env.WORKER_API_TOKEN = 'tok'
})

vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

/**
 * Content guarantee: LLM output must pass the shared schema; invalid output
 * triggers one correction retry; both failing falls back to content built
 * from the user's request — a generator must NEVER receive an empty model.
 */
describe('sidecar content guarantee (AI → validated JSON)', () => {
  function mockWorker() {
    // execution-plane enqueue + poll: both are HTTP calls to the worker.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
      if (String(url).includes('/api/v1/jobs') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        return { ok: true, json: async () => ({ job_id: 'j1', status: 'pending' }) } as any
      }
      if (String(url).includes('/api/v1/jobs/')) {
        return { ok: true, json: async () => ({ job_id: 'j1', status: 'completed', result: { file: { file_id: 'f1' } } }) } as any
      }
      if (String(url).includes('/download')) {
        return { ok: true, json: async () => ({ file_id: 'f1', file_name: 'x.pptx', mime_type: 'pptx', download_url: '/f1', expires_in: 3600 }) } as any
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    return () => vi.mocked(globalThis.fetch).mock.calls.find((c) => String(c[0]).includes('/api/v1/jobs') && (c[1] as any)?.method === 'POST')!;
  }

  test('invalid LLM JSON triggers a correction retry then succeeds', async () => {
    // 1st call: schema-invalid. 2nd call: valid slides.
    let genCalls = 0
    vi.mocked(deepseekChat).mockImplementation((messages: any[]) => {
      const text = messages.map((m: any) => m.content || '').join('\n')
      if (text.includes('intent classifier')) return Promise.resolve('sidecar\n')
      genCalls++
      if (genCalls === 1) return Promise.resolve('{"title": "x"}') // schema-invalid → retry
      return Promise.resolve('{"schemaVersion":1,"title":"PPT","slides":[{"title":"背景","content":[{"type":"paragraph","text":"内容"}]}]}')
    })
    const findEnqueue = mockWorker()

    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }
    // #451: rendering goes through installable plugins.
    const install = await app.inject({
      method: 'POST', url: '/api/v1/plugins/install', headers,
      payload: JSON.stringify({ pluginId: 'heurion/pptx' }),
    })
    expect(install.statusCode).toBe(200)

    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers,
      payload: JSON.stringify({ text: '帮我做一个 PPT' }),
    })
    expect(res.statusCode).toBe(200)
    // 1× intent classifier + original + correction retry.
    expect(deepseekChat).toHaveBeenCalledTimes(3)
    // The retry prompt carried the schema errors.
    const retryPrompt = vi.mocked(deepseekChat).mock.calls[2][0][0].content
    expect(String(retryPrompt)).toContain('未通过校验')
    // The worker payload passed validation (schema-valid slides).
    const enqueueCall = findEnqueue()
    const enqueueBody = JSON.parse(String((enqueueCall[1] as any).body))
    expect(enqueueBody.payload.data.slides.length).toBeGreaterThan(0)
  }, 30000)

  test('both LLM attempts failing falls back to user-request content (never empty)', async () => {
    vi.mocked(deepseekChat).mockResolvedValue('not json at all') // both attempts unparseable
    const findEnqueue = mockWorker()

    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }
    // #451: rendering goes through installable plugins.
    const install = await app.inject({
      method: 'POST', url: '/api/v1/plugins/install', headers,
      payload: JSON.stringify({ pluginId: 'heurion/table' }),
    })
    expect(install.statusCode).toBe(200)

    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers,
      payload: JSON.stringify({ text: '帮我生成一个表格' }),
    })
    expect(res.statusCode).toBe(200)
    // Fallback content derived from the user text — table non-empty.
    const enqueueCall = findEnqueue()
    const enqueueBody = JSON.parse(String((enqueueCall[1] as any).body))
    const data = enqueueBody.payload.data
    expect(data.headers.length).toBeGreaterThan(0)
    expect(data.rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(data)).toContain('帮我生成一个表格')
  }, 30000)
})
