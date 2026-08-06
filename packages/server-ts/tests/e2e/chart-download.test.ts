import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import fs from 'fs'
import path from 'path'
import { RenderChartTool } from '../../src/tools/render-chart-tool.js'
import { issueChartToken, verifyChartToken } from '../../src/modules/files/files.router.js'

vi.mock('../../src/common/llm.js', () => ({
  deepseekChat: vi.fn(),
  deepseekStream: vi.fn(),
  getApiKey: () => 'test-key',
  setLlmTelemetryService: vi.fn(),
  DEEPSEEK_CHAT_MODEL: 'deepseek-v4-flash',
  DEEPSEEK_PREMIUM_MODEL: 'deepseek-v4-pro',
}))

beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', 'test-key') })
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('#213 chart download endpoint', () => {
  test('chart renders via tokenized URL (no auth header)', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const tmp = fs.mkdtempSync(path.join('/tmp', 'chart-dl-'))
    process.env.TWIN_BASE_DIR = tmp

    const tool = new RenderChartTool({ userId, sessionId: 'doc-x' })
    const result = await tool.execute({ type: 'bar', data: [{ label: 'A', value: 3 }], title: 'T' })
    const out = JSON.parse(result.output as string)
    expect(out.url).toContain('token=')

    // img-style request: NO Authorization header, only the query token
    const res = await app.inject({ method: 'GET', url: out.url })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('image/svg+xml')
    expect(res.body).toContain('<svg')
  }, 30000)

  test('download without token is unauthorized', async () => {
    const app = await getApp()
    const res = await app.inject({ method: 'GET', url: '/api/v1/files/download/nonexistent' })
    expect(res.statusCode).toBe(401)
  }, 30000)

  test('invalid token is rejected', async () => {
    const app = await getApp()
    const res = await app.inject({ method: 'GET', url: '/api/v1/files/download/nonexistent?token=bad' })
    expect(res.statusCode).toBe(401)
  }, 30000)

  test('issueChartToken validates and rejects tampered tokens', () => {
    const t = issueChartToken('file_x', 'user_1')
    expect(verifyChartToken('file_x', t)).toBe('user_1')
    expect(verifyChartToken('file_x', 'wrong')).toBeNull()
    expect(verifyChartToken('other', t)).toBeNull()
  })

  afterEach(() => { delete process.env.TWIN_BASE_DIR })
})
