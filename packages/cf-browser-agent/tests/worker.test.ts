import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * #485 — CF Agent Browser execution endpoint. TDD: tests first.
 * Worker handler: POST /browser-task with x-worker-token auth, delegating
 * to the agents-SDK browser run (mocked here — real browser binding is a
 * deploy-time resource).
 */

// Mock the agents SDK so tests run without a real Cloudflare environment.
const mocks = vi.hoisted(() => {
  const runBrowserMock = vi.fn()
  return { runBrowserMock }
})

vi.mock('../src/agent.js', () => ({
  runBrowserTask: mocks.runBrowserMock,
  buildLlm: () => ({ id: 'mock-model' }),
}))

import worker from '../src/index.js'

async function handle(req: Request, env: Record<string, unknown>): Promise<Response> {
  // The worker module exports a default fetch handler.
  return (worker as any).default
    ? (worker as any).default(req, env)
    : (worker as any).fetch(req, env)
}

beforeEach(() => {
  mocks.runBrowserMock.mockReset()
  mocks.runBrowserMock.mockResolvedValue({
    conclusion: '任务完成：图表已生成',
    dom_summary: '页面包含图表区域',
    steps: ['打开页面', '执行操作'],
    screenshot_url: 'data:image/png;base64,xxx',
  })
})

describe('browser-task endpoint (#485)', () => {
  const env = {
    WRB_TASK_TOKEN: 'secret-token',
    LLM_API_KEY: 'llm-key',
    LLM_BASE_URL: 'https://api.example.com/v1',
    LLM_MODEL: 'test-model',
    BROWSER: { kind: 'browser-binding' },
    LOADER: { kind: 'loader-binding' },
  }

  test('1. no token → 401', async () => {
    const res = await handle(new Request('https://worker.test/browser-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'x' }),
    }), env)
    expect(res.status).toBe(401)
    expect(mocks.runBrowserMock).not.toHaveBeenCalled()
  })

  test('2. valid token + instruction → 200 with conclusion/steps/screenshot', async () => {
    const res = await handle(new Request('https://worker.test/browser-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-token': 'secret-token' },
      body: JSON.stringify({ instruction: '登录 heurion.org 并生成 EGFR 通路图', url: 'https://heurion.org' }),
    }), env)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.conclusion).toContain('图表已生成')
    expect(Array.isArray(body.steps)).toBe(true)
    expect(body.screenshot_url).toContain('data:image')
    // Delegation shape.
    expect(mocks.runBrowserMock).toHaveBeenCalledWith(
      expect.objectContaining({ instruction: '登录 heurion.org 并生成 EGFR 通路图', url: 'https://heurion.org' }),
      expect.objectContaining({ browser: expect.anything(), loader: expect.anything(), llm: expect.anything() }),
    )
  })

  test('3. empty instruction → 400', async () => {
    const res = await handle(new Request('https://worker.test/browser-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-token': 'secret-token' },
      body: JSON.stringify({ instruction: '' }),
    }), env)
    expect(res.status).toBe(400)
    expect(mocks.runBrowserMock).not.toHaveBeenCalled()
  })

  test('4. agent failure → 502 with readable error', async () => {
    mocks.runBrowserMock.mockRejectedValue(new Error('browser crashed'))
    const res = await handle(new Request('https://worker.test/browser-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-token': 'secret-token' },
      body: JSON.stringify({ instruction: 'x' }),
    }), env)
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toContain('browser crashed')
  })

  test('5. GET /healthz → ok (no auth required)', async () => {
    const res = await handle(new Request('https://worker.test/healthz'), env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})
