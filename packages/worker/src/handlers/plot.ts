import { saveFile } from '../storage.js'
// #686: SVG 渲染族拆到 svg.ts(纯函数)。
import { generateBarSvg, generateLineSvg, generatePieSvg } from './svg.js'

export interface PlotInput {
  type: 'bar' | 'line' | 'pie'
  title?: string
  labels: string[]
  datasets: { label: string; data: number[]; color?: string }[]
  width?: number
  height?: number
}

/**
 * Sidecar jobs send the legacy plot contract:
 * { plot_type, title, x_label, y_label, series: [{ x, y, label }] }.
 * Normalize it into the SVG-renderer model (labels + datasets) and also
 * tolerate the direct { type, labels, datasets } shape for direct callers.
 */
function toPlotInput(payload: any): PlotInput {
  const p = payload || {}
  const series = Array.isArray(p.series)
    ? p.series
    : Array.isArray(p.datasets)
      ? p.datasets.map((ds: any) => ({ x: p.labels || [], y: ds.data || [], label: ds.label }))
      : []
  const labels: string[] = Array.isArray(p.labels)
    ? p.labels.map(String)
    : (series[0]?.x || []).map(String)
  const datasets: PlotInput['datasets'] = series.map((s: any) => ({
    label: String(s?.label || ''),
    data: Array.isArray(s?.y) ? (s.y as number[]) : [],
  }))
  return {
    type: (p.plot_type || p.type || 'bar') as PlotInput['type'],
    title: p.title ? String(p.title) : undefined,
    labels,
    datasets,
    width: p.width,
    height: p.height,
  }
}

export async function renderPlot(payload: any) {
  const input = toPlotInput(payload)
  const w = input.width || 600
  const h = input.height || 400
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
