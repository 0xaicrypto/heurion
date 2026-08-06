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

  test('#228 beam_scan schematic draws real elements, not a placeholder', () => {
    const svg = renderSvgChart({ type: 'schematic', template: 'beam_scan', title: '图4：笔束扫描', description: '像喷墨打印机一样逐点打印剂量' })
    expect(svg).toContain('<svg')
    // Real drawn parts: nozzle, fan beams, targets, depth-dose curve.
    expect(svg).toContain('喷嘴')
    expect(svg).toContain('扫描束流')
    expect(svg).toContain('GTV')
    expect(svg).toContain('CTV')
    expect(svg).toContain('布拉格峰')
    // The old empty-shell marker must be gone.
    expect(svg).not.toContain('SVG 占位')
    expect(svg).not.toContain('generate_image')
  })

  test('#228 custom schematic elements render as real primitives', () => {
    const svg = renderSvgChart({
      type: 'schematic',
      title: '照射野示意',
      elements: [
        { kind: 'rect', x: 60, y: 80, w: 120, h: 40, text: '机头', fill: '#e0f2fe' },
        { kind: 'beam', x: 120, y: 120, h: 120, width: 30, exitWidth: 12, text: '射束', color: '#0ea5e9' },
        { kind: 'circle', x: 120, y: 240, r: 22, text: '靶区', fill: '#fee2e2' },
        { kind: 'arrow', x: 250, y: 60, x2: 330, y2: 60, text: '', color: '#64748b' },
      ],
    })
    expect(svg).toContain('<polygon') // beam trapezoid
    expect(svg).toContain('机头')
    expect(svg).toContain('射束')
    expect(svg).toContain('靶区')
    expect(svg).not.toContain('SVG 占位')
  })

  test('#228 tool schema accepts template and elements', async () => {
    const userId = await getAuthUserId()
    const tool = new RenderChartTool({ userId, sessionId: 'doc-x' })
    const result = await tool.execute({ type: 'schematic', template: 'beam_scan', title: '笔束扫描示意' })
    expect(result.success).toBe(true)
    const out = JSON.parse(result.output as string)
    expect(out.markdown).toContain('![笔束扫描示意]')
  }, 30000)

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
