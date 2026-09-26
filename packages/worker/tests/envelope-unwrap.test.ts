import { describe, test, expect, vi, beforeEach } from 'vitest'
import { SCHEMA_VERSION } from '@heurion/contracts'

/**
 * P0 — 渲染 payload 信封解包 + plot 契约校验（Rule 1）。
 *
 * 修复前 plot/table/pdf handler 直接把整个 job payload 当内容读，而控制面
 * （asset-render-pipeline / plugin-capability）发的是
 * `{ template_id, schema_version, content_type, data: <RenderContent> }` 信封：
 *  - plot：series/datasets 全读不到 → 空图（且未过契约校验）；
 *  - table/pdf：headers/sections 读不到 → 必定失败。
 * 修复后解包 data 并（plot）做 validateRenderContent；legacy 裸形状容错保留。
 */
vi.mock('../src/storage.js', () => ({
  saveFile: vi.fn(async (buffer: Buffer, name: string, mime: string) => ({ fileId: 'f1', fileName: name, mimeType: mime })),
}))

import { renderPlot } from '../src/handlers/plot.js'
import { renderTable } from '../src/handlers/table.js'
import { convertToPdf } from '../src/handlers/pdf.js'

async function lastSavedBuffer(): Promise<Buffer> {
  const { saveFile } = await import('../src/storage.js')
  const calls = (saveFile as any).mock.calls
  return calls[calls.length - 1][0] as Buffer
}

const ENVELOPE = <T>(data: T) => ({
  template_id: 'default',
  output_name: 'out',
  schema_version: SCHEMA_VERSION,
  content_type: 'sidecar.render_plot',
  data,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('P0: render_plot 解包 data + 契约校验', () => {
  const plotData = {
    schemaVersion: SCHEMA_VERSION,
    type: 'bar' as const,
    title: '疗效对比',
    series: [{ label: '系列A', x: [1, 2], y: [3, 5] }],
  }

  test('控制面信封 → 渲染出含真实数据集的 SVG（修复前为空图）', async () => {
    const res = await renderPlot(ENVELOPE(plotData))
    expect((res as { fileName: string }).fileName).toBe('chart.svg')
    const svg = (await lastSavedBuffer()).toString('utf-8')
    expect(svg).toContain('<svg')
    expect(svg).toContain('系列A') // 数据系列进入图例 — 信封解包失败时不会出现
    expect(svg).toContain('疗效对比')
  })

  test('legacy 裸形状（plot_type/series 无 schemaVersion）仍可渲染', async () => {
    const res = await renderPlot({
      plot_type: 'line',
      title: 'Legacy',
      series: [{ label: 'L', x: [1, 2], y: [2, 4] }],
    })
    expect((res as { fileName: string }).fileName).toBe('chart.svg')
    expect((await lastSavedBuffer()).toString('utf-8')).toContain('L')
  })

  test('空 series → 契约校验失败，给出可读错误（不渲染半截图）', async () => {
    await expect(renderPlot(ENVELOPE({ schemaVersion: SCHEMA_VERSION, type: 'bar', title: '空图', series: [] })))
      .rejects.toThrow(/contract validation/)
  })
})

describe('P0: render_table / convert_to_pdf 解包 data', () => {
  test('table 控制面信封 → 非空 PDF', async () => {
    const res = await renderTable(ENVELOPE({
      schemaVersion: SCHEMA_VERSION,
      title: '基线表',
      headers: ['患者', '年龄'],
      rows: [['张三', '58']],
    }))
    expect((res as { fileName: string }).fileName).toBe('table.pdf')
    const buf = await lastSavedBuffer()
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-')
    expect(buf.length).toBeGreaterThan(500)
  })

  test('pdf 控制面信封 → 非空 PDF（修复前 sections 读不到必败）', async () => {
    const res = await convertToPdf(ENVELOPE({
      schemaVersion: SCHEMA_VERSION,
      title: '随访记录',
      sections: [{ heading: '随访', paragraphs: [{ type: 'paragraph', text: '患者恢复良好' }] }],
    }))
    expect((res as { fileName: string }).fileName).toBe('document.pdf')
    const buf = await lastSavedBuffer()
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-')
    expect(buf.length).toBeGreaterThan(500)
  })
})
