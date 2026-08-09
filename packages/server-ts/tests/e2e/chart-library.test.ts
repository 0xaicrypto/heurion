import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader } from '../setup.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

import { deepseekChat } from '../../src/common/llm.js'

/**
 * #402-followup: generated-chart library — lists render_scene/render_chart
 * outputs (Reactome + bioscene), detects mode, deletes.
 */
describe('generated chart library (#402-followup)', () => {
  beforeEach(() => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('REACTOME_DIAGRAMS_DIR', '')
    vi.stubEnv('REACTOME_DIAGRAMS_BASE_URL', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  test('library lists a generated bioscene scene with mode detection', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }

    // Generate a scene directly (no LLM needed) — render_scene via chat is
    // gated by the plugin; instead write a scene file the same way the tool does.
    const userId = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/user/profile', headers: await authHeader() })).payload).user_id
    const fs = await import('fs')
    const path = await import('path')
    const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="520" height="420" viewBox="0 0 520 420"><rect width="520" height="420" fill="#ffffff"/><path d="M1 1"/></svg>'
    fs.writeFileSync(path.join(dir, 'scene_test_abc.svg'), svg, 'utf-8')

    const res = await app.inject({
      method: 'GET', url: '/api/v1/files/generated', headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    const entry = body.charts.find((c: any) => c.file_id === 'scene_test_abc.svg')
    expect(entry).toBeDefined()
    expect(entry.mode).toBe('bioscene')
    expect(entry.url).toMatch(/^\/api\/v1\/files\/download\/scene_test_abc\.svg\?token=/)
    // Token works for <img> loading.
    const img = await app.inject({ method: 'GET', url: entry.url })
    expect(img.statusCode).toBe(200)
    expect(img.headers['content-type']).toContain('image/svg+xml')
  }, 30000)

  test('Reactome-style SVG is detected as reactome mode', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }
    const userId = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/user/profile', headers: await authHeader() })).payload).user_id
    const fs = await import('fs')
    const path = await import('path')
    const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    const svg = '<svg stroke-dasharray="none" viewBox="-15 -15 3513 1968" xmlns="http://www.w3.org/2000/svg"><g/></svg>'
    fs.writeFileSync(path.join(dir, 'scene_reactome_xyz.svg'), svg, 'utf-8')

    const res = await app.inject({
      method: 'GET', url: '/api/v1/files/generated', headers: await authHeader(),
    })
    const body = JSON.parse(res.payload)
    const entry = body.charts.find((c: any) => c.file_id === 'scene_reactome_xyz.svg')
    expect(entry.mode).toBe('reactome')
  }, 30000)

  test('delete removes the chart file', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }
    const userId = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/user/profile', headers: await authHeader() })).payload).user_id
    const fs = await import('fs')
    const path = await import('path')
    const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'chart_test_123.svg'), '<svg/>', 'utf-8')

    const del = await app.inject({
      method: 'DELETE', url: '/api/v1/files/generated/chart_test_123.svg', headers: await authHeader(),
    })
    expect(del.statusCode).toBe(200)
    expect(JSON.parse(del.payload).deleted).toBe(true)
    expect(fs.existsSync(path.join(dir, 'chart_test_123.svg'))).toBe(false)
  }, 30000)
})
