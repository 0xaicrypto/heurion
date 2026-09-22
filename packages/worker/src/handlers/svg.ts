/**
 * Plot SVG renderers (#686) — pure chart-drawing functions extracted from
 * plot.ts (which keeps payload normalization + dispatch). No I/O.
 */
import type { PlotInput } from './plot.js'
import { PLOT_COLORS } from './common.js'

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 有限数值守卫 — undefined/NaN 不得进入 SVG 几何（会渲染出 NaN 坐标）。 */
function finiteOr(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * #中-14: 数据集值多于 labels 时，此前按 labels 循环导致超出部分被静默丢弃
 * （柱状图）— 现在 SVG 内给出可见注记。行/列几何只消费 labels 范围。
 */
function droppedValuesNote(input: PlotInput): number {
  const maxDataLen = Math.max(0, ...input.datasets.map((d) => d.data.length))
  return Math.max(0, maxDataLen - input.labels.length)
}

function dropNoteText(input: PlotInput, w: number, h: number, count: number): string {
  if (count <= 0) return ''
  return `<text x="${w / 2}" y="${h - 6}" text-anchor="middle" font-size="11" fill="#B45309">⚠️ ${count} 个数据值超出标签数（${input.labels.length}），已省略</text>`
}

export function generateBarSvg(input: PlotInput, w: number, h: number): string {
  const pad = { top: 40, right: 20, bottom: 50, left: 60 }
  const chartW = w - pad.left - pad.right
  const chartH = h - pad.top - pad.bottom

  const labelCount = input.labels.length
  const dropped = droppedValuesNote(input)
  const allValues = input.datasets.flatMap((d) => d.data).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const maxVal = Math.max(...allValues, 1)
  const barCount = Math.max(1, labelCount * input.datasets.length)
  const barWidth = Math.max(10, (chartW / barCount) * 0.7)
  const groupWidth = chartW / Math.max(1, labelCount)

  let bars = ''
  const colors = PLOT_COLORS

  input.labels.forEach((label, li) => {
    input.datasets.forEach((ds, di) => {
      const value = finiteOr(ds.data[li])
      const x = pad.left + li * groupWidth + di * barWidth + (groupWidth - barWidth * input.datasets.length) / 2
      const barH = (value / maxVal) * chartH
      const y = pad.top + chartH - barH
      const color = ds.color || colors[(di + li * input.datasets.length) % colors.length]
      bars += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${color}" opacity="0.8">
        <title>${escapeXml(ds.label)}: ${value}</title>
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
    ${dropNoteText(input, w, h, dropped)}
    <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + chartH}" stroke="#ccc" stroke-width="1"/>
    <line x1="${pad.left}" y1="${pad.top + chartH}" x2="${w - pad.right}" y2="${pad.top + chartH}" stroke="#ccc" stroke-width="1"/>
  </svg>`
}

export function generateLineSvg(input: PlotInput, w: number, h: number): string {
  const pad = { top: 40, right: 20, bottom: 50, left: 60 }
  const chartW = w - pad.left - pad.right
  const chartH = h - pad.top - pad.bottom

  const labelCount = input.labels.length
  const dropped = droppedValuesNote(input)
  const allValues = input.datasets.flatMap((d) => d.data).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const maxVal = Math.max(...allValues, 1)
  const colors = PLOT_COLORS

  let paths = ''
  let dots = ''
  input.datasets.forEach((ds, di) => {
    const color = ds.color || colors[di % colors.length]
    // #中-14: 超出 labels 范围的数据点此前会画到图表区之外（x 越界）— 截断
    // 并在 SVG 底部给可见注记；labels 缺失时按数据长度铺开。
    const data = labelCount > 0 ? ds.data.slice(0, labelCount) : ds.data
    const denom = Math.max((labelCount > 0 ? labelCount : data.length) - 1, 1)
    const points = data.map((val, i) => {
      const x = pad.left + (i / denom) * chartW
      const y = pad.top + chartH - (finiteOr(val) / maxVal) * chartH
      return { x, y }
    })
    const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
    paths += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`
    points.forEach((p, i) => {
      dots += `<circle cx="${p.x}" cy="${p.y}" r="3" fill="${color}">
        <title>${escapeXml(ds.label)}: ${finiteOr(data[i])}</title>
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
    ${dropNoteText(input, w, h, dropped)}
    <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + chartH}" stroke="#ccc" stroke-width="1"/>
    <line x1="${pad.left}" y1="${pad.top + chartH}" x2="${w - pad.right}" y2="${pad.top + chartH}" stroke="#ccc" stroke-width="1"/>
  </svg>`
}

export function generatePieSvg(input: PlotInput, w: number, h: number): string {
  const cx = w * 0.4
  const cy = h / 2
  const r = Math.min(cx - 20, cy - 40, 100)
  const total = input.datasets[0]?.data.reduce((a, b) => a + b, 0) || 1
  const colors = PLOT_COLORS

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

