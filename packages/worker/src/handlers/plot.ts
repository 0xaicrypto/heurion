import { saveFile } from '../storage.js'

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

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function generateBarSvg(input: PlotInput, w: number, h: number): string {
  const pad = { top: 40, right: 20, bottom: 50, left: 60 }
  const chartW = w - pad.left - pad.right
  const chartH = h - pad.top - pad.bottom

  const allValues = input.datasets.flatMap((d) => d.data)
  const maxVal = Math.max(...allValues, 1)
  const barCount = input.labels.length * input.datasets.length
  const barWidth = Math.max(10, (chartW / barCount) * 0.7)
  const groupWidth = chartW / input.labels.length

  let bars = ''
  const colors = ['#4dc9f6', '#f67019', '#537bc4', '#acc236', '#166a8f', '#00a950', '#58595b', '#8549ba']

  input.labels.forEach((label, li) => {
    input.datasets.forEach((ds, di) => {
      const x = pad.left + li * groupWidth + di * barWidth + (groupWidth - barWidth * input.datasets.length) / 2
      const barH = (ds.data[li] / maxVal) * chartH
      const y = pad.top + chartH - barH
      const color = ds.color || colors[(di + li * input.datasets.length) % colors.length]
      bars += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${color}" opacity="0.8">
        <title>${escapeXml(ds.label)}: ${ds.data[li]}</title>
      </rect>`
    })
  })

  let yLabels = ''
  const ySteps = 5
  for (let i = 0; i <= ySteps; i++) {
    const val = (maxVal / ySteps) * i
    const y = pad.top + chartH - (val / maxVal) * chartH
    yLabels += `<text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="#666">${Math.round(val)}</text>`
    yLabels += `<line x1="${pad.left}" y1="${y}" x2="${w - pad.right}" y2="${y}" stroke="#eee" stroke-width="1"/>`
  }

  let xLabels = ''
  input.labels.forEach((label, li) => {
    const x = pad.left + li * groupWidth + groupWidth / 2
    xLabels += `<text x="${x}" y="${h - pad.bottom + 18}" text-anchor="middle" font-size="11" fill="#666">${escapeXml(label)}</text>`
  })

  let legend = ''
  input.datasets.forEach((ds, di) => {
    const color = ds.color || colors[di % colors.length]
    const lx = pad.left + di * 120
    legend += `<rect x="${lx}" y="12" width="12" height="12" fill="${color}"/>`
    legend += `<text x="${lx + 18}" y="22" font-size="12" fill="#333">${escapeXml(ds.label)}</text>`
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    ${input.title ? `<text x="${w / 2}" y="22" text-anchor="middle" font-size="14" font-weight="bold" fill="#333">${escapeXml(input.title)}</text>` : ''}
    ${legend}
    ${yLabels}
    ${xLabels}
    ${bars}
    <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + chartH}" stroke="#ccc" stroke-width="1"/>
    <line x1="${pad.left}" y1="${pad.top + chartH}" x2="${w - pad.right}" y2="${pad.top + chartH}" stroke="#ccc" stroke-width="1"/>
  </svg>`
}

function generateLineSvg(input: PlotInput, w: number, h: number): string {
  const pad = { top: 40, right: 20, bottom: 50, left: 60 }
  const chartW = w - pad.left - pad.right
  const chartH = h - pad.top - pad.bottom

  const allValues = input.datasets.flatMap((d) => d.data)
  const maxVal = Math.max(...allValues, 1)
  const colors = ['#4dc9f6', '#f67019', '#537bc4', '#acc236', '#166a8f', '#00a950', '#58595b', '#8549ba']

  let paths = ''
  let dots = ''
  input.datasets.forEach((ds, di) => {
    const color = ds.color || colors[di % colors.length]
    const points = ds.data.map((val, i) => {
      const x = pad.left + (i / Math.max(input.labels.length - 1, 1)) * chartW
      const y = pad.top + chartH - (val / maxVal) * chartH
      return { x, y }
    })
    const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
    paths += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`
    points.forEach((p) => {
      dots += `<circle cx="${p.x}" cy="${p.y}" r="3" fill="${color}">
        <title>${escapeXml(ds.label)}: ${ds.data[points.indexOf(p)]}</title>
      </circle>`
    })
  })

  let yLabels = ''
  const ySteps = 5
  for (let i = 0; i <= ySteps; i++) {
    const val = (maxVal / ySteps) * i
    const y = pad.top + chartH - (val / maxVal) * chartH
    yLabels += `<text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="#666">${Math.round(val)}</text>`
    yLabels += `<line x1="${pad.left}" y1="${y}" x2="${w - pad.right}" y2="${y}" stroke="#eee" stroke-width="1"/>`
  }

  let xLabels = ''
  input.labels.forEach((label, i) => {
    const x = pad.left + (i / Math.max(input.labels.length - 1, 1)) * chartW
    xLabels += `<text x="${x}" y="${h - pad.bottom + 18}" text-anchor="middle" font-size="11" fill="#666">${escapeXml(label)}</text>`
  })

  let legend = ''
  input.datasets.forEach((ds, di) => {
    const color = ds.color || colors[di % colors.length]
    const lx = pad.left + di * 120
    legend += `<rect x="${lx}" y="12" width="12" height="12" fill="${color}"/>`
    legend += `<text x="${lx + 18}" y="22" font-size="12" fill="#333">${escapeXml(ds.label)}</text>`
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    ${input.title ? `<text x="${w / 2}" y="22" text-anchor="middle" font-size="14" font-weight="bold" fill="#333">${escapeXml(input.title)}</text>` : ''}
    ${legend}
    ${yLabels}
    ${xLabels}
    ${paths}
    ${dots}
    <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + chartH}" stroke="#ccc" stroke-width="1"/>
    <line x1="${pad.left}" y1="${pad.top + chartH}" x2="${w - pad.right}" y2="${pad.top + chartH}" stroke="#ccc" stroke-width="1"/>
  </svg>`
}

function generatePieSvg(input: PlotInput, w: number, h: number): string {
  const cx = w * 0.4
  const cy = h / 2
  const r = Math.min(cx - 20, cy - 40, 100)
  const total = input.datasets[0]?.data.reduce((a, b) => a + b, 0) || 1
  const colors = ['#4dc9f6', '#f67019', '#537bc4', '#acc236', '#166a8f', '#00a950', '#58595b', '#8549ba']

  let slices = ''
  let startAngle = -Math.PI / 2
  input.datasets[0]?.data.forEach((val, i) => {
    const angle = (val / total) * 2 * Math.PI
    const endAngle = startAngle + angle
    const x1 = cx + r * Math.cos(startAngle)
    const y1 = cy + r * Math.sin(startAngle)
    const x2 = cx + r * Math.cos(endAngle)
    const y2 = cy + r * Math.sin(endAngle)
    const largeArc = angle > Math.PI ? 1 : 0
    const color = colors[i % colors.length]
    const label = input.labels[i] || `Slice ${i}`
    slices += `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z" fill="${color}" opacity="0.8">
      <title>${escapeXml(label)}: ${val} (${((val / total) * 100).toFixed(1)}%)</title>
    </path>`
    startAngle = endAngle
  })

  let legend = ''
  input.labels.forEach((label, i) => {
    const color = colors[i % colors.length]
    const ly = 40 + i * 22
    legend += `<rect x="${w * 0.65}" y="${ly}" width="12" height="12" fill="${color}"/>`
    legend += `<text x="${w * 0.65 + 18}" y="${ly + 10}" font-size="11" fill="#333">${escapeXml(label)}</text>`
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    ${input.title ? `<text x="${w / 2}" y="22" text-anchor="middle" font-size="14" font-weight="bold" fill="#333">${escapeXml(input.title)}</text>` : ''}
    ${slices}
    ${legend}
  </svg>`
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
