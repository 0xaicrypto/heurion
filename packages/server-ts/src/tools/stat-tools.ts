/**
 * #361: statistics tools — pure-TypeScript implementations (zero external
 * deps, deterministic on the server). stat_describe / stat_ttest /
 * stat_chisq / stat_km (+ log-rank). Unified output shape:
 * { method, test_stat, p_value, effect_size, interpretation }.
 *
 * Numerical helpers: incomplete beta (t-distribution CDF) and regularized
 * lower incomplete gamma (chi-squared CDF) via standard series/continued
 * fractions.
 */
import { BaseTool, ToolResult } from './base-tool.js'

/* ─────────────────────────── math helpers ─────────────────────────── */

function lnGamma(x: number): number {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
  let y = x
  let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.000000000190015
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y
  return -tmp + Math.log(2.5066282746310005 * ser / x)
}

/** Regularized lower incomplete gamma P(a, x). */
function gammaP(a: number, x: number): number {
  if (x < 0 || a <= 0) return NaN
  if (x < a + 1) {
    // series
    let ap = a
    let sum = 1 / a
    let del = sum
    for (let i = 0; i < 200; i++) {
      ap += 1
      del *= x / ap
      sum += del
      if (Math.abs(del) < Math.abs(sum) * 1e-12) break
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a))
  }
  // continued fraction
  let b = x + 1 - a
  let c = 1 / 1e-30
  let d = 1 / b
  let h = d
  for (let i = 1; i <= 200; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < 1e-30) d = 1e-30
    c = b + an / c
    if (Math.abs(c) < 1e-30) c = 1e-30
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-12) break
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h
}

/** Regularized incomplete beta I_x(a, b) — t-distribution CDF backbone. */
function betaI(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  if (x < (a + 1) / (a + b + 2)) {
    return bt * betaCF(x, a, b) / a
  }
  return 1 - bt * betaCF(1 - x, b, a) / b
}

function betaCF(x: number, a: number, b: number): number {
  const maxIter = 200
  const eps = 3e-12
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - qab * x / qap
  if (Math.abs(d) < 1e-30) d = 1e-30
  d = 1 / d
  let h = d
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < 1e-30) d = 1e-30
    c = 1 + aa / c
    if (Math.abs(c) < 1e-30) c = 1e-30
    d = 1 / d
    h *= d * c
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < 1e-30) d = 1e-30
    c = 1 + aa / c
    if (Math.abs(c) < 1e-30) c = 1e-30
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < eps) break
  }
  return h
}

/** Two-tailed p for a t statistic with df degrees of freedom. */
export function tTwoTailedP(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return NaN
  const x = df / (df + t * t)
  return betaI(x, df / 2, 0.5)
}

/** Survival probability for chi-squared statistic with df degrees of freedom. */
export function chiSquaredP(chi2: number, df: number): number {
  if (chi2 < 0 || df <= 0) return NaN
  return 1 - gammaP(df / 2, chi2 / 2)
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function variance(xs: number[]): number {
  const m = mean(xs)
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)
}

function sd(xs: number[]): number {
  return Math.sqrt(variance(xs))
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base])
  return sorted[base]
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

function interpret(method: string, p: number, stat: number, extra?: string): string {
  const sig = p < 0.05
  const base = `${method}：${sig ? '差异有统计学意义' : '差异无统计学意义'}（p=${round4(p)}）${extra ? '；' + extra : ''}`
  return base
}

/* ─────────────────────────── tools ─────────────────────────── */

/** stat_describe — descriptive statistics for a numeric array. */
export class StatDescribeTool extends BaseTool {
  get name(): string { return 'stat_describe' }
  get description(): string {
    return 'Descriptive statistics (n, mean, median, SD, IQR, min/max) for a numeric array. Use for lab values, dosage, follow-up times. Output: { method, n, mean, median, sd, q1, q3, min, max }.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        values: { type: 'array', items: { type: 'number' }, description: 'Numeric observations' },
      },
      required: ['values'],
    }
  }
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const values = (args.values as number[] | undefined)?.map(Number).filter(Number.isFinite) || []
    if (values.length < 2) return { success: false, error: 'stat_describe needs at least 2 numeric values' }
    const sorted = [...values].sort((a, b) => a - b)
    const out = {
      method: 'descriptive',
      n: values.length,
      mean: round4(mean(values)),
      median: round4(quantile(sorted, 0.5)),
      sd: round4(sd(values)),
      q1: round4(quantile(sorted, 0.25)),
      q3: round4(quantile(sorted, 0.75)),
      min: round4(sorted[0]),
      max: round4(sorted[sorted.length - 1]),
    }
    return { success: true, output: JSON.stringify(out, null, 2) }
  }
}

/** stat_ttest — Welch two-sample t-test. */
export class StatTTestTool extends BaseTool {
  get name(): string { return 'stat_ttest' }
  get description(): string {
    return "Two-sample Welch t-test (equal variance not assumed). Compares two groups (e.g. responders vs non-responders). Output: { method: 'welch_t', test_stat, df, p_value, effect_size (Cohen's d), interpretation }."
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        group_a: { type: 'array', items: { type: 'number' }, description: 'Group A observations' },
        group_b: { type: 'array', items: { type: 'number' }, description: 'Group B observations' },
        label_a: { type: 'string', default: 'Group A' },
        label_b: { type: 'string', default: 'Group B' },
      },
      required: ['group_a', 'group_b'],
    }
  }
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const a = ((args.group_a as number[]) || []).map(Number).filter(Number.isFinite)
    const b = ((args.group_b as number[]) || []).map(Number).filter(Number.isFinite)
    if (a.length < 2 || b.length < 2) return { success: false, error: 'Each group needs at least 2 values' }
    const ma = mean(a)
    const mb = mean(b)
    const va = variance(a)
    const vb = variance(b)
    const se = Math.sqrt(va / a.length + vb / b.length)
    if (se === 0) return { success: false, error: 'Zero variance in both groups' }
    const t = (ma - mb) / se
    const df = (va / a.length + vb / b.length) ** 2 / ((va / a.length) ** 2 / (a.length - 1) + (vb / b.length) ** 2 / (b.length - 1))
    const p = tTwoTailedP(t, df)
    const pooledSd = Math.sqrt(((a.length - 1) * va + (b.length - 1) * vb) / (a.length + b.length - 2))
    const d = (ma - mb) / (pooledSd || 1)
    return {
      success: true,
      output: JSON.stringify({
        method: 'welch_t',
        test_stat: round4(t),
        df: round4(df),
        p_value: round4(p),
        effect_size: round4(d),
        interpretation: interpret('t 检验', p, t, `Cohen's d=${round4(d)}`),
      }, null, 2),
    }
  }
}

/** stat_chisq — chi-squared test on a contingency table. */
export class StatChiSqTool extends BaseTool {
  get name(): string { return 'stat_chisq' }
  get description(): string {
    return 'Chi-squared test for association on a 2×k contingency table (e.g. response rate by treatment arm). Pass rows as arrays. Output: { method: "chisq", test_stat, df, p_value, interpretation }.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        table: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'Contingency table rows, e.g. [[20,10],[15,25]]' },
      },
      required: ['table'],
    }
  }
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const raw = args.table as number[][] | undefined
    if (!Array.isArray(raw) || raw.length < 2 || !raw.every((r) => Array.isArray(r) && r.length >= 2)) {
      return { success: false, error: 'table must be a 2+ × 2+ numeric matrix' }
    }
    const table = raw.map((r) => r.map(Number).filter(Number.isFinite))
    if (table.some((r) => r.length !== table[0].length)) return { success: false, error: 'All rows must have the same length' }
    const rows = table.length
    const cols = table[0].length
    const rowTotals = table.map((r) => r.reduce((a, b) => a + b, 0))
    const colTotals = Array.from({ length: cols }, (_, j) => table.reduce((a, r) => a + r[j], 0))
    const total = rowTotals.reduce((a, b) => a + b, 0)
    if (total === 0) return { success: false, error: 'Empty table' }
    let chi2 = 0
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const expected = (rowTotals[i] * colTotals[j]) / total
        if (expected > 0) chi2 += (table[i][j] - expected) ** 2 / expected
      }
    }
    const df = (rows - 1) * (cols - 1)
    const p = chiSquaredP(chi2, df)
    return {
      success: true,
      output: JSON.stringify({
        method: 'chisq',
        test_stat: round4(chi2),
        df,
        p_value: round4(p),
        interpretation: interpret('卡方检验', p, chi2, `df=${df}`),
      }, null, 2),
    }
  }
}

interface KmRow { time: number; censored: boolean; group: string }

/** stat_km — Kaplan-Meier survival estimate + log-rank test (2 groups). */
export class StatKmTool extends BaseTool {
  get name(): string { return 'stat_km' }
  get description(): string {
    return 'Kaplan-Meier survival analysis with log-rank test. Pass per-patient rows: { time, event } in each group (event=true for death/progression, false for censored). Output: survival curve points (for render_chart line plot) + log-rank p. Groups: group_a (treated) vs group_b (control).'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        group_a: { type: 'array', items: { type: 'object', properties: { time: { type: 'number' }, event: { type: 'boolean' } }, required: ['time', 'event'] }, description: 'Group A (treated) survival rows' },
        group_b: { type: 'array', items: { type: 'object', properties: { time: { type: 'number' }, event: { type: 'boolean' } }, required: ['time', 'event'] }, description: 'Group B (control) survival rows' },
      },
      required: ['group_a', 'group_b'],
    }
  }
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const parse = (rows: any): KmRow[] | null => {
      if (!Array.isArray(rows) || rows.length < 2) return null
      const out: KmRow[] = []
      for (const r of rows) {
        const t = Number(r?.time)
        if (!Number.isFinite(t) || t < 0) return null
        out.push({ time: t, censored: r.event !== true, group: '' })
      }
      return out
    }
    const a = parse(args.group_a)
    const b = parse(args.group_b)
    if (!a || !b) return { success: false, error: 'group_a and group_b need ≥2 rows of {time, event}' }

    // KM estimate for a group (step function at event times).
    const kmCurve = (rows: KmRow[]) => {
      const sorted = [...rows].sort((x, y) => x.time - y.time)
      const points: { time: number; survival: number }[] = [{ time: 0, survival: 1 }]
      let n = rows.length
      let s = 1
      for (const row of sorted) {
        if (!row.censored) {
          s *= (n - 1) / n
          points.push({ time: row.time, survival: s })
        }
        n -= 1
      }
      return points
    }

    // Log-rank test (two groups).
    const allTimes = [...new Set([...a, ...b].filter((r) => !r.censored).map((r) => r.time))].sort((x, y) => x - y)
    let o1 = 0
    let e1 = 0
    for (const t of allTimes) {
      const d1 = a.filter((r) => r.time === t && !r.censored).length
      const d2 = b.filter((r) => r.time === t && !r.censored).length
      const n1 = a.filter((r) => r.time >= t).length
      const n2 = b.filter((r) => r.time >= t).length
      const d = d1 + d2
      const n = n1 + n2
      if (n > 0) {
        o1 += d1
        e1 += (n1 * d) / n
      }
    }
    const o2 = (a.filter((r) => !r.censored).length + b.filter((r) => !r.censored).length) - o1
    const e2 = (a.filter((r) => !r.censored).length + b.filter((r) => !r.censored).length) - e1
    const chi2 = (o1 - e1) ** 2 / Math.max(1e-9, e1) + (o2 - e2) ** 2 / Math.max(1e-9, e2)
    const p = chiSquaredP(chi2, 1)

    return {
      success: true,
      output: JSON.stringify({
        method: 'kaplan_meier_logrank',
        test_stat: round4(chi2),
        p_value: round4(p),
        interpretation: interpret('log-rank 检验', p, chi2, '生存曲线差异'),
        curve_a: kmCurve(a),
        curve_b: kmCurve(b),
        median_survival_a: medianSurvival(kmCurve(a)),
        median_survival_b: medianSurvival(kmCurve(b)),
      }, null, 2),
    }
  }
}

function medianSurvival(points: { time: number; survival: number }[]): number | null {
  for (let i = 1; i < points.length; i++) {
    if (points[i].survival <= 0.5) {
      // linear interpolation between the crossing step
      const prev = points[i - 1]
      const cur = points[i]
      if (prev.survival === cur.survival) return cur.time
      return prev.time + (cur.time - prev.time) * (prev.survival - 0.5) / (prev.survival - cur.survival)
    }
  }
  return null
}
