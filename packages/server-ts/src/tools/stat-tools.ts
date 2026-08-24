/**
 * #361: statistics tools — deterministic pure-TS implementations on top of
 * the pure math in lib/stats-math.ts (#684). stat_describe / stat_ttest /
 * stat_chisq / stat_km (+ log-rank) / stat_plot. The LLM-backed advisor
 * (stat_ai) lives in tools/stat-advisor-tool.ts so this module stays
 * deterministic (stats-engine's "pure-TS fallback" promise holds).
 *
 * Unified output shape: { method, test_stat, p_value, effect_size,
 * interpretation }.
 */
import { BaseTool, ToolResult } from './base-tool.js'
import { mean, sd, variance, quantile, round4, round6, tTwoTailedP, tCritical95, chiSquaredP, shapiroOk } from '../lib/stats-math.js'

interface KmRow { time: number; censored: boolean; group: string }

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

    // #405: normality gate — non-normal samples auto-degrade to Mann-Whitney
    // with an explicit declaration (mirrors the Python backend).
    const normA = shapiroOk(a)
    const normB = shapiroOk(b)
    if (!(normA && normB)) {
      const rankA = a.map((v) => v).sort((x, y) => x - y)
      const rankB = b.map((v) => v).sort((x, y) => x - y)
      const all = [...rankA.map((v) => ({ v, g: 0 })), ...rankB.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v)
      const ranks = new Map<number, number>()
      for (let i = 0; i < all.length; i++) {
        const key = all[i].v
        let sum = i + 1
        let count = 1
        let j = i + 1
        while (j < all.length && all[j].v === key) { sum += j + 1; count++; j++ }
        const avg = sum / count
        for (let k = i; k < j; k++) ranks.set(all[k].v, avg)
        i = j - 1
      }
      let rankSumA = 0
      for (const v of rankA) rankSumA += ranks.get(v)!
      const n1 = a.length
      const n2 = b.length
      const u = rankSumA - (n1 * (n1 + 1)) / 2
      // Normal approximation for U (adequate for the gate).
      const muU = (n1 * n2) / 2
      const sigmaU = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12)
      const z = (u - muU) / sigmaU
      const p = tTwoTailedP(Math.abs(z), 1e9)
      const effect = 1 - (2 * u) / (n1 * n2)
      return {
        success: true,
        output: JSON.stringify({
          method: 'mann_whitney',
          test_stat: round4(u),
          p_value: round4(p),
          effect_size: round4(effect),
          interpretation: interpret('Mann-Whitney（正态性不满足，自动降级）', p, u),
          gating: { normality_gate: 'failed', auto_degraded_to: 'mann_whitney', declared: true },
        }, null, 2),
      }
    }

    const se = Math.sqrt(va / a.length + vb / b.length)
    if (se === 0) return { success: false, error: 'Zero variance in both groups' }
    const t = (ma - mb) / se
    const df = (va / a.length + vb / b.length) ** 2 / ((va / a.length) ** 2 / (a.length - 1) + (vb / b.length) ** 2 / (b.length - 1))
    const p = tTwoTailedP(t, df)
    const pooledSd = Math.sqrt(((a.length - 1) * va + (b.length - 1) * vb) / (a.length + b.length - 2))
    const d = (ma - mb) / (pooledSd || 1)
    const tCrit = tCritical95(df)
    const ciLo = (ma - mb) - tCrit * se
    const ciHi = (ma - mb) + tCrit * se
    return {
      success: true,
      output: JSON.stringify({
        method: 'welch_t',
        test_stat: round6(t),
        df: round6(df),
        p_value: round6(p),
        effect_size: round6(d),
        ci_95: [round6(ciLo), round6(ciHi)],
        interpretation: interpret('t 检验', p, t, `Cohen's d=${round6(d)}`),
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
    // #405: Cramér's V effect size.
    const v = total > 0 && Math.min(rows, cols) > 1 ? Math.sqrt(Math.max(0, chi2) / (total * (Math.min(rows, cols) - 1))) : 0
    return {
      success: true,
      output: JSON.stringify({
        method: 'chisq',
        test_stat: round6(chi2),
        df,
        p_value: round6(p),
        effect_size: round6(v),
        interpretation: interpret('卡方检验', p, chi2, `df=${df}, Cramér's V=${round6(v)}`),
      }, null, 2),
    }
  }
}

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

    // #405: Mantel-Cox log-rank (hypergeometric variance, matches lifelines).
    const allTimes = [...new Set([...a, ...b].filter((r) => !r.censored).map((r) => r.time))].sort((x, y) => x - y)
    let o1 = 0
    let e1 = 0
    let v1 = 0
    for (const t of allTimes) {
      const d1 = a.filter((r) => r.time === t && !r.censored).length
      const d2 = b.filter((r) => r.time === t && !r.censored).length
      const n1 = a.filter((r) => r.time >= t).length
      const n2 = b.filter((r) => r.time >= t).length
      const d = d1 + d2
      const n = n1 + n2
      if (n > 1) {
        o1 += d1
        e1 += (n1 * d) / n
        v1 += (n1 * n2 * d * (n - d)) / (n * n * (n - 1))
      }
    }
    const chi2 = v1 > 0 ? (o1 - e1) ** 2 / v1 : 0
    const p = chiSquaredP(chi2, 1)

    return {
      success: true,
      output: JSON.stringify({
        method: 'kaplan_meier_logrank',
        test_stat: round6(chi2),
        p_value: round6(p),
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

/**
 * stat_plot — converts statistics output into render_chart-compatible data
 * (line/bar). KM curves produce per-group line data; forest plots produce
 * log-scaled bars. The LLM calls render_chart with the returned data.
 */
export class StatPlotTool extends BaseTool {
  get name(): string { return 'stat_plot' }
  get description(): string {
    return 'Prepare statistics output for plotting via render_chart. For kaplan-meier: pass two survival curves and get line data (call render_chart type=line with each). For forest: pass {label,hr,lo,hi} rows and get bar data (log scale). Output: { charts: [{type,data,title,x_label,y_label}], notes }.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        plot_type: { type: 'string', enum: ['km', 'forest'], description: 'km = Kaplan-Meier survival curves; forest = forest plot (HR with CI)' },
        group_a: { type: 'array', items: { type: 'object', properties: { time: { type: 'number' }, survival: { type: 'number' } } }, description: 'KM curve A points (from stat_km curve_a)' },
        group_b: { type: 'array', items: { type: 'object', properties: { time: { type: 'number' }, survival: { type: 'number' } } }, description: 'KM curve B points (from stat_km curve_b)' },
        label_a: { type: 'string', default: 'Group A' },
        label_b: { type: 'string', default: 'Group B' },
        forest: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, hr: { type: 'number' }, lo: { type: 'number' }, hi: { type: 'number' } } }, description: 'Forest plot rows (HR with 95% CI bounds)' },
        title: { type: 'string', default: 'Survival analysis' },
      },
      required: ['plot_type'],
    }
  }
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const plotType = String(args.plot_type)
    if (plotType === 'km') {
      const a = (args.group_a as any[]) || []
      const b = (args.group_b as any[]) || []
      if (a.length === 0 && b.length === 0) return { success: false, error: 'km needs group_a and/or group_b points' }
      const toLine = (points: any[]) => points.map((p: any) => ({ label: String(Number(p.time) || 0), value: Number(p.survival) || 0 }))
      const charts: any[] = []
      if (a.length > 0) charts.push({ type: 'line', data: toLine(a), title: `${args.title || 'Survival'} — ${args.label_a || 'Group A'}`, x_label: 'Time', y_label: 'Survival probability' })
      if (b.length > 0) charts.push({ type: 'line', data: toLine(b), title: `${args.title || 'Survival'} — ${args.label_b || 'Group B'}`, x_label: 'Time', y_label: 'Survival probability' })
      return {
        success: true,
        output: JSON.stringify({
          method: 'stat_plot_km',
          charts,
          notes: 'Call render_chart once per chart with its type/data/title/x_label/y_label.',
        }, null, 2),
      }
    }
    if (plotType === 'forest') {
      const rows = (args.forest as any[]) || []
      if (rows.length === 0) return { success: false, error: 'forest needs rows of {label, hr, lo, hi}' }
      // Log-scale bars centered at 1 (HR=1 → 0 on log axis).
      const data = rows.map((r) => ({ label: String(r.label), value: Math.log2(Number(r.hr) || 1) }))
      const notes = rows.map((r) => {
        const hr = Number(r.hr) || 1
        const lo = Number(r.lo) || hr
        const hi = Number(r.hi) || hr
        const sig = lo > 1 || hi < 1 ? 'statistically significant' : 'not significant'
        return `${r.label}: HR ${hr.toFixed(2)} (95% CI ${lo.toFixed(2)}–${hi.toFixed(2)}) — ${sig}`
      })
      return {
        success: true,
        output: JSON.stringify({
          method: 'stat_plot_forest',
          charts: [{ type: 'bar', data, title: args.title || 'Forest plot (log2 HR)', x_label: 'Subgroup', y_label: 'log2(HR)' }],
          notes,
        }, null, 2),
      }
    }
    return { success: false, error: `Unsupported plot_type: ${plotType}` }
  }
}
