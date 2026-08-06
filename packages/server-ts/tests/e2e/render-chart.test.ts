import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import fs from 'fs'
import path from 'path'
import { renderSvgChart, braggPeakCurve } from '../../src/tools/chart-renderer.js'
import { RenderChartTool } from '../../src/tools/render-chart-tool.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

import { deepseekChat } from '../../src/common/llm.js'

beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', 'test-key') })
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('#176 render_chart', () => {
  test('SVG renderer: dose_curve produces a Bragg-peak shaped SVG', () => {
    const svg = renderSvgChart({ type: 'dose_curve', title: '布拉格峰' })
    expect(svg).toContain('<svg')
    expect(svg).toContain('<polyline')
    expect(svg).toContain('布拉格峰')
  })

  test('bragg curve peaks near the expected depth', () => {
    const curve = braggPeakCurve(10, 18, 40)
    const peak = curve.reduce((best, d) => (d.value > best.value ? d : best), curve[0])
    expect(parseFloat(peak.label)).toBeGreaterThan(8)
    expect(parseFloat(peak.label)).toBeLessThan(12)
    // distal falloff: tail is well below the peak
    const tail = curve[curve.length - 1].value
    expect(tail).toBeLessThan(peak.value * 0.5)
  })

  test('bar chart renders rects', () => {
    const svg = renderSvgChart({ type: 'bar', data: [{ label: 'A', value: 3 }, { label: 'B', value: 5 }], title: '对比' })
    expect(svg).toContain('<rect')
  })

  test('tool saves SVG attachment and returns URL', async () => {
    const userId = await getAuthUserId()
    const tool = new RenderChartTool({ userId, sessionId: 'doc-x' })
    const result = await tool.execute({ type: 'dose_curve', title: '质子剂量' })
    expect(result.success).toBe(true)
    const out = JSON.parse(result.output as string)
    expect(out.url).toContain('/api/v1/files/download/')
    expect(out.markdown).toContain('![质子剂量]')
    const filepath = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads', out.file_id)
    expect(fs.existsSync(filepath)).toBe(true)
  }, 30000)

  test('LLM tool loop: chat call render_chart → chart_created SSE', async () => {
    const app = await getApp()
    const sessionId = `chart_${Date.now()}`
    let calls = 0
    vi.mocked(deepseekChat).mockImplementation((messages: any) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      calls++
      if (calls === 1) {
        return Promise.resolve(`<tool_call>${JSON.stringify({ name: 'render_chart', arguments: { type: 'bar', data: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }], title: '对比' } })}</tool_call>`)
      }
      return Promise.resolve('图表已生成。')
    })

    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '画个对比图', session_id: sessionId }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('"type":"chart_created"')
    expect(res.payload).toContain('files/download')
  }, 30000)
})
