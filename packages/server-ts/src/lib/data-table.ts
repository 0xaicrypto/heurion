/**
 * #406: data input pipeline — CSV parsing, table-shape inference, preview.
 * Normalizes uploaded tabular data into the six analysis shapes the stats
 * tools consume, so the LLM can propose the right test.
 */
export type DataShape =
  | 'values_2groups'
  | 'values_paired'
  | 'grouped_table'
  | 'contingency_table'
  | 'xy_pairs'
  | 'survival_table'
  | 'continuous_x_y'

export interface DataTableInfo {
  shape: DataShape
  headers: string[]
  rows: Array<Array<string | number>>
  preview: Array<Array<string | number>>
  totalRows: number
  totalCols: number
  columns: Array<{ name: string; kind: 'number' | 'text' }>
  summary: string
}

/** Minimal RFC-4180-ish CSV parser (quotes, commas, newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((f) => f.trim() !== '')) rows.push(row)
      row = []
    } else {
      field += c
    }
  }
  row.push(field)
  if (row.some((f) => f.trim() !== '')) rows.push(row)
  return rows
}

function isNumber(v: string): boolean {
  const n = Number(v)
  return v.trim() !== '' && Number.isFinite(n)
}

/** Infer the analysis shape from headers + rows. */
export function inferShape(headers: string[], rows: string[][]): DataShape {
  const lower = headers.map((h) => h.toLowerCase().trim())
  const has = (...names: string[]) => lower.some((h) => names.some((n) => h.includes(n)))
  const cols = headers.length

  // Survival: time + event (+ optional group)
  if (has('time', '随访', '生存时间') && has('event', '事件', 'status')) {
    return has('group', '组', 'arm') ? 'survival_table' : 'survival_table'
  }
  // Continuous X/Y (e.g. dose-response, growth curves)
  if (has('x', 'dose', '浓度', '时间点') && has('y', 'value', 'response', '吸光度')) {
    return has('group', '组') ? 'grouped_table' : 'continuous_x_y'
  }
  // Pairwise: two numeric value columns (baseline/post or A/B)
  if (cols === 2 && rows.every((r) => isNumber(r[0]) && isNumber(r[1]))) {
    return 'values_paired'
  }
  // Grouped: one text group column + one numeric value column
  if (cols === 2) {
    const col0Numeric = rows.every((r) => isNumber(r[0]))
    const col1Numeric = rows.every((r) => isNumber(r[1]))
    if ((!col0Numeric && col1Numeric) || (col1Numeric && has('group', '组'))) return 'grouped_table'
    if (col0Numeric && col1Numeric) return 'values_paired'
  }
  // Contingency: all numeric counts with a label column
  if (cols >= 2 && rows.every((r) => r.slice(1).every((v) => isNumber(v)))) {
    return 'contingency_table'
  }
  // Two numeric columns of independent groups (wide format A | B)
  if (cols === 2 && rows.every((r) => isNumber(r[0]) && isNumber(r[1]))) {
    return 'values_2groups'
  }
  return 'grouped_table'
}

export function columnKinds(headers: string[], rows: string[][]): Array<{ name: string; kind: 'number' | 'text' }> {
  return headers.map((h, i) => ({
    name: h,
    kind: rows.every((r) => isNumber(r[i])) ? 'number' as const : 'text' as const,
  }))
}

export function summarize(shape: DataShape, headers: string[], rows: string[][]): string {
  const cols = columnKinds(headers, rows)
  const numeric = cols.filter((c) => c.kind === 'number')
  const summary: string[] = [
    `数据形状：${shape}（${rows.length} 行 × ${headers.length} 列）`,
    `列：${cols.map((c) => `${c.name}(${c.kind})`).join(', ')}`,
  ]
  for (const c of numeric.slice(0, 4)) {
    const idx = cols.indexOf(c)
    const vals = rows.map((r) => Number(r[idx])).filter(Number.isFinite)
    if (vals.length > 0) {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length
      const min = Math.min(...vals)
      const max = Math.max(...vals)
      summary.push(`${c.name}: 均值 ${mean.toFixed(2)}（范围 ${min}–${max}）`)
    }
  }
  return summary.join('\n')
}

/** Full pipeline: CSV text → info (shape + preview + summary). */
export function analyzeCsvText(text: string): DataTableInfo {
  const parsed = parseCsv(text)
  const rows = parsed.length > 0 ? parsed.slice(1) : []
  const headers = parsed.length > 0 ? parsed[0] : []
  const shape = inferShape(headers, rows)
  const columns = columnKinds(headers, rows)
  return {
    shape,
    headers,
    rows: rows.slice(0, 20).map((r) => r.map((v) => (isNumber(v) ? Number(v) : v))),
    preview: rows.slice(0, 10).map((r) => r.map((v) => (isNumber(v) ? Number(v) : v))),
    totalRows: rows.length,
    totalCols: headers.length,
    columns,
    summary: summarize(shape, headers, rows),
  }
}
