import { describe, test, expect, vi, beforeEach } from 'vitest'
import { SCHEMA_VERSION } from '@heurion/contracts'

/**
 * #1132 回归 — render_plot 文字分类标签不得被 map(Number) 成 NaN。
 * 修复前 legacy `{type,labels,datasets}` 与 `series.x` 字符串分类都会被
 * 强转 NaN → 契约 z.number() 拒绝 → 柱状/饼图直接报错（功能回退）。
 * 修复后分类文本经 categoryLabels 传给 SVG，契约 x 用序号。
 */
vi.mock('../src/storage.js', () => ({
  saveFile: vi.fn(async (buffer: Buffer, name: string, mime: string) => ({ fileName: name, mimeType: mime, fileId: 'f1' })),
}))

import { renderPlot } from '../src/handlers/plot.js'

async function lastSvg(): Promise<string> {
  const { saveFile } = await import('../src/storage.js')
  const calls = (saveFile as unknown as { mock: { calls: unknown[][] } }).mock.calls
  return (calls[calls.length - 1][0] as Buffer).toString('utf-8')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('#1132 render_plot 文字分类标签', () => {
  test('legacy datasets + 中文分类 → 渲染成功且 SVG 含分类文本、无 NaN', async () => {
    await renderPlot({
      type: 'bar',
      title: 'ORR',
      labels: ['对照组', '治疗组'],
      datasets: [{ label: 'ORR%', data: [32, 48] }],
    })
    const svg = await lastSvg()
    expect(svg).toContain('对照组')
    expect(svg).toContain('治疗组')
    expect(svg).not.toContain('NaN')
  })

  test('legacy series + 字符串 x（字母/季度）→ 渲染成功且保留标签', async () => {
    await renderPlot({
      plot_type: 'bar',
      title: '季度趋势',
      series: [{ label: 'OS', x: ['2024Q1', '2024Q2', '2024Q3'], y: [1, 2, 3] }],
    })
    const svg = await lastSvg()
    expect(svg).toContain('2024Q1')
    expect(svg).toContain('2024Q3')
    expect(svg).not.toContain('NaN')
  })

  test('饼图 + 中文分类 → 渲染成功(saveFile 收到 SVG)', async () => {
    await renderPlot({
      type: 'pie',
      title: '分型构成',
      labels: ['腺癌', '鳞癌'],
      datasets: [{ label: '占比', data: [60, 40] }],
    })
    const svg = await lastSvg()
    expect(svg).toContain('<svg')
    expect(svg).toContain('腺癌')
    expect(svg).not.toContain('NaN')
  })

  test('数值 x 行为不变(契约/控制面路径)', async () => {
    await renderPlot({
      template_id: 'default',
      schema_version: SCHEMA_VERSION,
      content_type: 'sidecar.render_plot',
      data: {
        schemaVersion: SCHEMA_VERSION,
        type: 'line',
        title: '数值轴',
        series: [{ label: 'L', x: [10, 20], y: [1, 2] }],
      },
    })
    const svg = await lastSvg()
    expect(svg).toContain('10')
    expect(svg).toContain('20')
    expect(svg).not.toContain('NaN')
  })

  test('空/非法数据仍被契约拒绝（不渲染半截图）', async () => {
    await expect(renderPlot({ type: 'bar', title: '空', series: [] })).rejects.toThrow(/contract validation/)
  })
})
