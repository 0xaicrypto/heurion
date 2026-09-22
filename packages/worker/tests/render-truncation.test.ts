import { describe, test, expect } from 'vitest'
import { normalizeTableRows } from '../src/handlers/table.js'
import { parseTableBlockData } from '../src/handlers/pptx.js'
import { generateBarSvg, generateLineSvg } from '../src/handlers/svg.js'

/**
 * #中-14 — worker 渲染层静默丢数据/截断：
 * - table 行超表头列数不再越界渲染（截断 + 可见提示触发条件）；
 * - pptx 表格 30 列/2000 字符截断返回可见计数；
 * - SVG 柱/线图超出 labels 的数据值给出可见注记，且不产生 NaN 几何。
 */
describe('#中-14 table 行越界不再静默', () => {
  test('超出表头列数的行被截断并计数（触发可见提示）', () => {
    const out = normalizeTableRows(2, [['a', 'b', 'c'], ['d', 'e'], ['f', 'g', 'h', 'i']])
    expect(out.colCount).toBe(2)
    expect(out.overflowRows).toBe(2)
    expect(out.rows).toEqual([['a', 'b'], ['d', 'e'], ['f', 'g']])
  })

  test('不超界时 overflowRows=0（不打扰）', () => {
    const out = normalizeTableRows(3, [['a', 'b'], ['c']])
    expect(out.overflowRows).toBe(0)
  })
})

describe('#中-14 pptx 表格截断可见计数', () => {
  test('列数 >30 与单元格 >2000 字符分别计数', () => {
    const wide = Array.from({ length: 32 }, (_, i) => `c${i}`)
    const long = 'x'.repeat(2500)
    const out = parseTableBlockData(JSON.stringify({ rows: [wide, [long]], header: true }))
    expect(out).not.toBeNull()
    expect(out!.truncatedCols).toBe(2)
    expect(out!.truncatedCells).toBe(1)
    expect(out!.rows[0]).toHaveLength(30)
    expect(out!.rows[1][0].length).toBe(2000)
  })

  test('未截断 → 计数 0', () => {
    const out = parseTableBlockData(JSON.stringify({ rows: [['a', 'b']] }))
    expect(out!.truncatedCols).toBe(0)
    expect(out!.truncatedCells).toBe(0)
  })
})

describe('#中-14 SVG 图表超标签数据不静默', () => {
  const input = {
    type: 'bar' as const,
    title: 'T',
    labels: ['A', 'B'],
    datasets: [{ label: 'S', data: [1, 2, 3, 4] }],
  }

  test('柱状图：超出的数据值有可见注记，且无 NaN 几何', () => {
    const svg = generateBarSvg(input, 600, 400)
    expect(svg).toContain('2 个数据值超出标签数')
    expect(svg).not.toContain('NaN')
  })

  test('折线图：超出的数据点被截断并注记，且无 NaN 几何', () => {
    const svg = generateLineSvg(input, 600, 400)
    expect(svg).toContain('2 个数据值超出标签数')
    expect(svg).not.toContain('NaN')
  })

  test('数据不缺时无注记（不打扰）', () => {
    const svg = generateBarSvg({ ...input, datasets: [{ label: 'S', data: [1, 2] }] }, 600, 400)
    expect(svg).not.toContain('超出标签数')
  })
})
