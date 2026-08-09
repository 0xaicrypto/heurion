/**
 * #176 — render_chart: deterministic SVG chart generation (zero external
 * dependencies). Supports clinical charts (Bragg-peak dose curves) where
 * accuracy matters — no generative model involved.
 * #228: schematic now draws real programmatic diagrams (element primitives
 * + the beam_scan template) instead of an empty placeholder box.
 */

export interface ChartInput {
  type: 'line' | 'bar' | 'dose_curve' | 'schematic'
  data?: Array<{ label: string; value: number }>
  /** #407: per-bar error (SD/SEM/CI half-width) for error bars. */
  errors?: Array<{ label: string; error: number }>
  /** #407: significance bracket — stars + optional p label. */
  sig?: { pair: [string, string]; stars: string; p?: string }
  title?: string
  x_label?: string
  y_label?: string
  description?: string
  /** #228: programmatic schematic — element primitives (schematic only). */
  elements?: SchematicElement[]
  /** #228: built-in diagram templates (schematic only). */
  template?: 'beam_scan'
}

export interface SchematicElement {
  kind: 'rect' | 'circle' | 'line' | 'arrow' | 'text' | 'beam'
  x: number
  y: number
  w?: number
  h?: number
  r?: number
  x2?: number
  y2?: number
  text?: string
  color?: string
  fill?: string
  dashed?: boolean
  /** beam: 束流宽度（梯形束道的入口宽度）。 */
  width?: number
  /** beam: 束流角度（度，0 = 垂直向下）。 */
  angle?: number
  /** beam: 束道出口宽度。 */
  exitWidth?: number
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
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

/**
 * #228: draw a pencil-beam scanning diagram — nozzle → beam channels →
 * target (GTV/CTV) with a depth-dose overlay strip. No placeholders.
 */
function renderBeamScan(title: string, description: string): string {
  const parts: string[] = []
  // Patient contour
  parts.push(`<path d="M 60 210 Q 130 175 200 195 T 330 195 T 440 210 L 440 250 L 60 250 Z" fill="#f8fafc" stroke="#94a3b8" stroke-width="1.5"/>`)
  // Surface line
  parts.push(`<line x1="60" y1="205" x2="440" y2="205" stroke="#64748b" stroke-width="1.5" stroke-dasharray="4 3"/>`)
  parts.push(`<text x="445" y="200" fill="#64748b" font-size="9">皮肤表面</text>`)
  // Beam nozzle
  parts.push(`<rect x="215" y="40" width="70" height="28" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>`)
  parts.push(`<text x="250" y="58" fill="#0369a1" font-size="10" text-anchor="middle">喷嘴</text>`)
  // Beam channels (fanned pencil beams)
  for (let i = 0; i < 7; i++) {
    const x0 = 230 + i * 8
    const x1 = 225 + i * 9
    const y0 = 68
    const y1 = 175 + (i % 2) * 8
    parts.push(`<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="#0ea5e9" stroke-width="2" opacity="0.75"/>`)
  }
  parts.push(`<text x="330" y="120" fill="#0284c7" font-size="10">扫描束流（逐点扫描）</text>`)
  // Targets
  parts.push(`<rect x="195" y="205" width="110" height="18" rx="3" fill="#fee2e2" stroke="#ef4444" stroke-width="1.2"/>`)
  parts.push(`<text x="250" y="218" fill="#b91c1c" font-size="9" text-anchor="middle">GTV（肿瘤靶区）</text>`)
  parts.push(`<rect x="180" y="190" width="140" height="34" rx="3" fill="none" stroke="#f59e0b" stroke-width="1.2" stroke-dasharray="4 3"/>`)
  parts.push(`<text x="335" y="212" fill="#b45309" font-size="9">CTV（临床靶区）</text>`)
  // Depth-dose overlay (Bragg peak inset)
  const curve = braggPeakCurve(8, 16, 24)
  const maxV = Math.max(1, ...curve.map((d) => d.value))
  const pts = curve
    .map((d, i) => {
      const x = 360 + (i / (curve.length - 1)) * 80
      const y = 235 - (d.value / maxV) * 60
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  parts.push(`<polyline points="${pts}" fill="none" stroke="#6366f1" stroke-width="2"/>`)
  parts.push(`<text x="400" y="242" fill="#6366f1" font-size="9" text-anchor="middle">深度剂量（布拉格峰）</text>`)
  // Legend
  parts.push(`<text x="60" y="285" fill="#64748b" font-size="9">${esc(description || '笔束扫描：束流逐点扫描覆盖靶区，剂量集中于布拉格峰。')}</text>`)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="300" viewBox="0 0 500 300">
<text x="250" y="26" fill="#1e293b" font-size="14" text-anchor="middle" font-weight="bold">${esc(title)}</text>
${parts.join('\n')}
</svg>`
}

/** #228: generic element renderer for schematic diagrams. */
function renderElements(elements: SchematicElement[]): string {
  return elements.map((e) => {
    switch (e.kind) {
      case 'rect':
        return `<rect x="${e.x}" y="${e.y}" width="${e.w ?? 40}" height="${e.h ?? 20}" rx="3" fill="${e.fill || '#e0f2fe'}" stroke="${e.color || '#0ea5e9'}" stroke-width="1.2"${e.dashed ? ' stroke-dasharray="4 3"' : ''}/>${e.text ? `<text x="${e.x + (e.w ?? 40) / 2}" y="${e.y + (e.h ?? 20) / 2 + 3}" fill="#334155" font-size="9" text-anchor="middle">${esc(e.text)}</text>` : ''}`
      case 'circle':
        return `<circle cx="${e.x}" cy="${e.y}" r="${e.r ?? 10}" fill="${e.fill || '#fee2e2'}" stroke="${e.color || '#ef4444'}" stroke-width="1.2"${e.dashed ? ' stroke-dasharray="4 3"' : ''}/>${e.text ? `<text x="${e.x}" y="${e.y + 3}" fill="#334155" font-size="9" text-anchor="middle">${esc(e.text)}</text>` : ''}`
      case 'line':
        return `<line x1="${e.x}" y1="${e.y}" x2="${e.x2 ?? e.x}" y2="${e.y2 ?? e.y}" stroke="${e.color || '#64748b'}" stroke-width="1.5"${e.dashed ? ' stroke-dasharray="4 3"' : ''}/>`
      case 'arrow': {
        const x1 = e.x, y1 = e.y, x2 = e.x2 ?? e.x, y2 = e.y2 ?? e.y
        const angle = Math.atan2(y2 - y1, x2 - x1)
        const a = 8
        return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${e.color || '#64748b'}" stroke-width="1.5"/>
<polygon points="${x2},${y2} ${(x2 - a * Math.cos(angle - 0.4)).toFixed(1)},${(y2 - a * Math.sin(angle - 0.4)).toFixed(1)} ${(x2 - a * Math.cos(angle + 0.4)).toFixed(1)},${(y2 - a * Math.sin(angle + 0.4)).toFixed(1)}" fill="${e.color || '#64748b'}"/>`
      }
      case 'text':
        return `<text x="${e.x}" y="${e.y}" fill="${e.color || '#334155'}" font-size="${e.w || 11}" text-anchor="middle">${esc(e.text || '')}</text>`
      case 'beam': {
        // Beam channel: trapezoid from (x,y) angled, width → exitWidth.
        const rad = ((e.angle ?? 0) * Math.PI) / 180
        const len = e.h ?? 100
        const w0 = (e.width ?? 24) / 2
        const w1 = (e.exitWidth ?? 12) / 2
        const dx = Math.sin(rad) * len
        const dy = Math.cos(rad) * len
        const cx = Math.cos(rad), sx = Math.sin(rad)
        const p1 = `${(e.x - w0 * cx).toFixed(1)},${(e.y + w0 * sx).toFixed(1)}`
        const p2 = `${(e.x + w0 * cx).toFixed(1)},${(e.y - w0 * sx).toFixed(1)}`
        const p3 = `${(e.x + dx + w1 * cx).toFixed(1)},${(e.y + dy - w1 * sx).toFixed(1)}`
        const p4 = `${(e.x + dx - w1 * cx).toFixed(1)},${(e.y + dy + w1 * sx).toFixed(1)}`
        return `<polygon points="${p1} ${p2} ${p3} ${p4}" fill="${hexToRgba(e.color || '#0ea5e9', 0.18)}" stroke="${e.color || '#0ea5e9'}" stroke-width="1.3"/>${e.text ? `<text x="${(e.x + dx / 2).toFixed(1)}" y="${(e.y + dy / 2 + 3).toFixed(1)}" fill="#0369a1" font-size="9" text-anchor="middle">${esc(e.text)}</text>` : ''}`
      }
      default:
        return ''
    }
  }).join('\n')
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
    const errMap = new Map((input.errors || []).map((e) => [e.label, e.error]))
    data.forEach((d, i) => {
      const x = 40 + i * bw
      const h = (d.value / maxV) * 230
      body += `<rect x="${x + bw * 0.15}" y="${260 - h}" width="${bw * 0.7}" height="${h}" fill="#6366f1" rx="2"/>`
      body += `<text x="${x + bw / 2}" y="275" fill="#64748b" font-size="9" text-anchor="middle">${esc(d.label)}</text>`
      body += `<text x="${x + bw / 2}" y="${262 - h}" fill="#334155" font-size="9" text-anchor="middle">${d.value}</text>`
      // #407: error bars (SD/SEM/CI half-width scaled to the chart).
      const err = errMap.get(d.label)
      if (err && err > 0) {
        const errPx = Math.min(60, (err / maxV) * 230)
        const cx = x + bw / 2
        const top = 260 - h
        body += `<line x1="${cx}" y1="${top - errPx}" x2="${cx}" y2="${Math.max(0, top + errPx)}" stroke="#334155" stroke-width="1.2"/>`
        body += `<line x1="${cx - 3}" y1="${top - errPx}" x2="${cx + 3}" y2="${top - errPx}" stroke="#334155" stroke-width="1.2"/>`
        body += `<line x1="${cx - 3}" y1="${Math.max(0, top + errPx)}" x2="${cx + 3}" y2="${Math.max(0, top + errPx)}" stroke="#334155" stroke-width="1.2"/>`
      }
    })
    // #407: significance bracket across two bars (Prism-style stars).
    if (input.sig && input.sig.pair) {
      const [l1, l2] = input.sig.pair
      const i1 = data.findIndex((d) => d.label === l1)
      const i2 = data.findIndex((d) => d.label === l2)
      if (i1 >= 0 && i2 >= 0) {
        const x1 = 40 + i1 * bw + bw / 2
        const x2 = 40 + i2 * bw + bw / 2
        const maxH = Math.max(data[i1].value, data[i2].value)
        const topPx = 260 - (maxH / maxV) * 230 - 24
        body += `<line x1="${x1}" y1="${topPx}" x2="${x2}" y2="${topPx}" stroke="#dc2626" stroke-width="1.2"/>`
        body += `<line x1="${x1}" y1="${topPx}" x2="${x1}" y2="${topPx + 6}" stroke="#dc2626" stroke-width="1.2"/>`
        body += `<line x1="${x2}" y1="${topPx}" x2="${x2}" y2="${topPx + 6}" stroke="#dc2626" stroke-width="1.2"/>`
        const stars = input.sig.stars || '*'
        const label = input.sig.p ? `${stars} (p=${esc(input.sig.p)})` : stars
        body += `<text x="${(x1 + x2) / 2}" y="${topPx - 4}" fill="#dc2626" font-size="11" text-anchor="middle">${esc(label)}</text>`
      }
    }
  } else if (input.type === 'schematic' && input.template === 'beam_scan') {
    return renderBeamScan(input.title || '', input.description || '')
  } else if (input.type === 'schematic' && input.elements && input.elements.length > 0) {
    // #228: real programmatic diagram from element primitives.
    body = renderElements(input.elements)
    if (input.description) {
      body += `\n<text x="250" y="285" fill="#64748b" font-size="9" text-anchor="middle">${esc(input.description)}</text>`
    }
  } else {
    // Fallback: keep a minimal labeled frame, but now with a visible hint
    // that structured schematics are supported (#228).
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
