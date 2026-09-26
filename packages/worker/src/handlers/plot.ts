import { validateRenderContent, SCHEMA_VERSION, type PlotContent } from '@heurion/contracts'
import { saveFile } from '../storage.js'
// #686: SVG 渲染族拆到 svg.ts(纯函数)。
import { generateBarSvg, generateLineSvg, generatePieSvg } from './svg.js'
import { unwrapRenderPayload } from './common.js'

/**
 * #fix: 控制面信封 `{ data: PlotContent }` 解包后做契约校验（Rule 1）—
 * 此前直接读顶层字段导致图表为空，且未过 validateRenderContent。
 * Legacy 容错保留两种旧形状并归一化为 PlotContent：
 *  - sidecar plot: { plot_type, title, x_label, y_label, series:[{x,y,label}] }
 *  - 直调:        { type, labels, datasets:[{label,data}] }
 * 归一化后仍必须通过契约（标题/系列非空、x/y 长度与数值合法性），失败给
 * 出可读错误而不是渲染出空图。
 */
export function buildPlotContent(payload: unknown): PlotContent {
  const p = (unwrapRenderPayload(payload) || {}) as Record<string, unknown>

  let series: Array<{ label: string; x: number[]; y: number[] }> = []
  if (Array.isArray(p.series)) {
    series = p.series.map((sUnknown, i) => {
      const s = (sUnknown ?? {}) as Record<string, unknown>
      const y = Array.isArray(s.y) ? (s.y as unknown[]).map(Number) : []
      const x = Array.isArray(s.x) && s.x.length > 0 ? (s.x as unknown[]).map(Number) : y.map((_, k) => k + 1)
      return { label: String(s.label || `Series ${i + 1}`), x, y }
    })
  } else if (Array.isArray(p.datasets)) {
    const labels: unknown[] = Array.isArray(p.labels) ? p.labels : []
    series = p.datasets.map((dsUnknown, i) => {
      const ds = (dsUnknown ?? {}) as Record<string, unknown>
      const y = Array.isArray(ds.data) ? (ds.data as unknown[]).map(Number) : []
      const x = labels.length === y.length ? labels.map(Number) : y.map((_, k) => k + 1)
      return { label: String(ds.label || `Series ${i + 1}`), x, y }
    })
  }

  const plotType = typeof p.plot_type === 'string' ? p.plot_type : typeof p.type === 'string' ? p.type : 'bar'
  const content = {
    schemaVersion: SCHEMA_VERSION,
    type: plotType as PlotContent['type'],
    title: String(p.title || 'Plot'),
    ...(typeof p.x_label === 'string' && p.x_label.trim() ? { x_label: p.x_label.trim() } : {}),
    ...(typeof p.y_label === 'string' && p.y_label.trim() ? { y_label: p.y_label.trim() } : {}),
    series,
  }
  const check = validateRenderContent('sidecar.render_plot', content)
  if (!check.ok) {
    throw new Error(`render_plot payload failed contract validation: ${check.errors.join('; ')}`)
  }
  return check.data as PlotContent
}

/** SVG 渲染器输入（#686 拆分时的形状；由契约 PlotContent 投影而来）。 */
export interface PlotInput {
  type: 'bar' | 'line' | 'pie'
  title?: string
  labels: string[]
  datasets: { label: string; data: number[]; color?: string }[]
}

/** 契约 PlotContent → SVG 渲染器输入（series 即多数据集）。 */
export function toSvgInput(content: PlotContent): PlotInput {
  return {
    type: content.type,
    title: content.title,
    labels: (content.series[0]?.x || []).map(String),
    datasets: content.series.map((s) => ({ label: s.label, data: s.y })),
  }
}

export async function renderPlot(payload: unknown) {
  const input = toSvgInput(buildPlotContent(payload))
  // 尺寸不属契约（宽高是渲染偏好）— legacy 直调可传 width/height。
  const raw = (unwrapRenderPayload(payload) || {}) as Record<string, unknown>
  const w = Number(raw.width) > 0 ? Math.round(Number(raw.width)) : 600
  const h = Number(raw.height) > 0 ? Math.round(Number(raw.height)) : 400
  let svg: string

  switch (input.type) {
    case 'bar':
      svg = generateBarSvg(input, w, h)
      break
    case 'line':
      svg = generateLineSvg(input, w, h)
      break
    case 'pie':
      svg = generatePieSvg(input, w, h)
      break
    default:
      throw new Error(`Unsupported chart type: ${input.type}`)
  }

  const buffer = Buffer.from(svg, 'utf-8')
  return saveFile(buffer, 'chart.svg', 'image/svg+xml')
}
