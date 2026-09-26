import { validateRenderContent, SCHEMA_VERSION, type PlotContent } from '@heurion/contracts'
import { saveFile } from '../storage.js'
// #686: SVG 渲染族拆到 svg.ts(纯函数)。
import { generateBarSvg, generateLineSvg, generatePieSvg } from './svg.js'
import { unwrapRenderPayload } from './common.js'

/** 归一化结果:契约内容 + 分类轴标签(#1132 — 文字分类不落进契约 x)。 */
export interface NormalizedPlot {
  content: PlotContent
  categoryLabels?: string[]
}

/** 数组是否全为有限数字(#1132: 文字分类标签不得 map(Number) 成 NaN)。 */
function allFiniteNumbers(values: unknown[]): boolean {
  return values.length > 0 && values.every((v) => typeof v === 'number' && Number.isFinite(v))
}

/**
 * #fix: 控制面信封 `{ data: PlotContent }` 解包后做契约校验（Rule 1）—
 * 此前直接读顶层字段导致图表为空，且未过 validateRenderContent。
 * Legacy 容错保留两种旧形状并归一化为 PlotContent：
 *  - sidecar plot: { plot_type, title, x_label, y_label, series:[{x,y,label}] }
 *  - 直调:        { type, labels, datasets:[{label,data}] }
 * #1132: 契约的 x 只收 number — 文字分类（['对照组','治疗组']、['2024Q1']、
 * series.x 为字符串）不逐个强转，而是整体判定为分类轴：契约 x 用序号，
 * 分类文本经 categoryLabels 传给 SVG 渲染器（toSvgInput）。旧实现
 * map(Number) 产生 NaN 被 z.number() 拒绝，文字分类图直接失败（功能回退）。
 */
export function normalizePlot(payload: unknown): NormalizedPlot {
  const p = (unwrapRenderPayload(payload) || {}) as Record<string, unknown>

  let categoryLabels: string[] | undefined
  let series: Array<{ label: string; x: number[]; y: number[] }> = []
  if (Array.isArray(p.series)) {
    series = p.series.map((sUnknown, i) => {
      const s = (sUnknown ?? {}) as Record<string, unknown>
      const y = Array.isArray(s.y) ? (s.y as unknown[]).map(Number) : []
      const rawX = Array.isArray(s.x) ? (s.x as unknown[]) : []
      const xNumeric = allFiniteNumbers(rawX)
      if (!xNumeric && rawX.length > 0 && categoryLabels === undefined) {
        categoryLabels = rawX.map(String)
      }
      const x = xNumeric ? (rawX as number[]) : y.map((_, k) => k + 1)
      return { label: String(s.label || `Series ${i + 1}`), x, y }
    })
  } else if (Array.isArray(p.datasets)) {
    // legacy datasets: labels 即分类轴（旧行为:labels map(String) 供 SVG），
    // 契约 x 一律用序号,分类文本单独携带。
    const labels: unknown[] = Array.isArray(p.labels) ? p.labels : []
    if (labels.length > 0) categoryLabels = labels.map(String)
    series = p.datasets.map((dsUnknown, i) => {
      const ds = (dsUnknown ?? {}) as Record<string, unknown>
      const y = Array.isArray(ds.data) ? (ds.data as unknown[]).map(Number) : []
      const x = y.map((_, k) => k + 1)
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
  return { content: check.data as PlotContent, categoryLabels }
}

/** 兼容入口（既有调用方拿契约内容）。 */
export function buildPlotContent(payload: unknown): PlotContent {
  return normalizePlot(payload).content
}

/** SVG 渲染器输入（#686 拆分时的形状；由契约 PlotContent 投影而来）。 */
export interface PlotInput {
  type: 'bar' | 'line' | 'pie'
  title?: string
  labels: string[]
  datasets: { label: string; data: number[]; color?: string }[]
}

/** 契约 PlotContent → SVG 渲染器输入（series 即多数据集）。
 *  #1132: categoryLabels 优先（文字分类轴），否则用契约 x 的数值标签。 */
export function toSvgInput(content: PlotContent, categoryLabels?: string[]): PlotInput {
  return {
    type: content.type,
    title: content.title,
    labels: categoryLabels ?? (content.series[0]?.x || []).map(String),
    datasets: content.series.map((s) => ({ label: s.label, data: s.y })),
  }
}

export async function renderPlot(payload: unknown) {
  const normalized = normalizePlot(payload)
  const input = toSvgInput(normalized.content, normalized.categoryLabels)
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
