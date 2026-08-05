/**
 * #176 — render_chart: deterministic SVG chart generation (zero external
 * dependencies). Supports clinical charts (Bragg-peak dose curves) where
 * accuracy matters — no generative model involved.
 */

export interface ChartInput {
  type: 'line' | 'bar' | 'dose_curve' | 'schematic'
  data?: Array<{ label: string; value: number }>
  title?: string
  x_label?: string
  y_label?: string
  description?: string
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Depth-dose model approximating a Bragg peak (proton therapy). */
export function braggPeakCurve(peakDepth = 10, maxDepth = 18, samples = 40): Array<{ label: string; value: number }> {
  const out: Array<{ label: string; value: number }> = []
  for (let i = 0; i < samples; i++) {
    const d = (i / (samples - 1)) * maxDepth
    // plateau + sharp peak + distal falloff (Bragg-like shape)
    const plateau = 0.55 * (1 - Math.exp(-d * 0.6))
    const peak = 1.6 * Math.exp(-Math.pow((d - peakDepth) / 0.7, 2) / 2)
    const falloff = d > peakDepth ? Math.exp(-(d - peakDepth) * 1.1) : 1
    out.push({ label: d.toFixed(1), value: +(plateau + peak * falloff).toFixed(3) })
  }
  return out
}

function axes(maxValue: number, xLabel: string, yLabel: string) {
  return `<line x1="40" y1="260" x2="460" y2="260" stroke="#94a3b8" stroke-width="1"/>
<line x1="40" y1="20" x2="40" y2="260" stroke="#94a3b8" stroke-width="1"/>
<text x="250" y="285" fill="#64748b" font-size="11" text-anchor="middle">${esc(xLabel)}</text>
<text x="18" y="140" fill="#64748b" font-size="11" text-anchor="middle" transform="rotate(-90 18 140)">${esc(yLabel)}</text>
<text x="250" y="12" fill="#334155" font-size="12" text-anchor="middle" font-weight="bold">${esc('')}</text>`
}

export function renderSvgChart(input: ChartInput): string {
  const W = 500
  const H = 300
  const title = input.title || ''
  let body = ''

  const data = input.type === 'dose_curve' && (!input.data || input.data.length === 0)
    ? braggPeakCurve()
    : (input.data || [])

  const maxV = Math.max(1, ...data.map((d) => d.value))
  const n = data.length

  if (input.type === 'dose_curve' || input.type === 'line') {
    const points = data
      .map((d, i) => {
        const x = 40 + (n <= 1 ? 0 : (i / (n - 1)) * 420)
        const y = 260 - (d.value / maxV) * 230
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
    body = `<polyline points="${points}" fill="none" stroke="#0ea5e9" stroke-width="2.5"/>`
    // point markers + last label
    data.forEach((d, i) => {
      if (i % Math.ceil(n / 8) === 0 || i === n - 1) {
        const x = 40 + (n <= 1 ? 0 : (i / (n - 1)) * 420)
        const y = 260 - (d.value / maxV) * 230
        body += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="#0ea5e9"/>`
        body += `<text x="${x.toFixed(1)}" y="275" fill="#64748b" font-size="9" text-anchor="middle">${esc(d.label)}</text>`
      }
    })
  } else if (input.type === 'bar') {
    const bw = n > 0 ? 420 / n : 40
    data.forEach((d, i) => {
      const x = 40 + i * bw
      const h = (d.value / maxV) * 230
      body += `<rect x="${x + bw * 0.15}" y="${260 - h}" width="${bw * 0.7}" height="${h}" fill="#6366f1" rx="2"/>`
      body += `<text x="${x + bw / 2}" y="275" fill="#64748b" font-size="9" text-anchor="middle">${esc(d.label)}</text>`
      body += `<text x="${x + bw / 2}" y="${262 - h}" fill="#334155" font-size="9" text-anchor="middle">${d.value}</text>`
    })
  } else {
    // schematic: a labelled placeholder block — complex diagrams need the
    // external image tool (#177); this keeps the tool loop useful offline.
    body = `<rect x="60" y="60" width="380" height="160" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-dasharray="4 4"/>
<text x="250" y="130" fill="#334155" font-size="13" text-anchor="middle" font-weight="bold">示意图（SVG 占位）</text>
<text x="250" y="160" fill="#64748b" font-size="11" text-anchor="middle">${esc(input.description || '')}</text>
<text x="250" y="185" fill="#94a3b8" font-size="10" text-anchor="middle">复杂示意图建议使用 generate_image 工具</text>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<text x="250" y="26" fill="#1e293b" font-size="14" text-anchor="middle" font-weight="bold">${esc(title)}</text>
${axes(maxV, input.x_label || '', input.y_label || '')}
${body}
</svg>`
}
