/**
 * #445 — Stats engine (Strategy): the single stats execution backend.
 *
 * - PythonStatsEngine: authoritative scipy/statsmodels/lifelines results via
 *   the Python stats worker (#404) when STATS_WORKER_URL is configured.
 * - TypeScriptStatsEngine: deterministic pure-TS fallback (stat-tools) —
 *   verified against the Python golden suite (scripts/cross-check-stats.ts,
 *   agreement < 1e-8).
 *
 * Both engines return the SAME report shape:
 *   describe      → { method, n, mean, median, sd, q1, q3, min, max }
 *   t-test        → { method:'welch_t', test_stat, df, p_value, effect_size,
 *                     ci_95, interpretation, gating? }
 *   chi-square    → { method:'chisq', test_stat, df, p_value, effect_size,
 *                     interpretation }
 *   kaplan-meier  → { method:'kaplan_meier_logrank', test_stat, p_value,
 *                     interpretation, curve_a, curve_b, ... }
 */
export interface StatsInput {
  test: string
  group_a?: number[]
  group_b?: number[]
  table?: number[][]
  survival_a?: Array<{ time: number; event: boolean }>
  survival_b?: Array<{ time: number; event: boolean }>
  values?: number[]
}

export interface StatsEngine {
  analyze(input: StatsInput): Promise<Record<string, unknown>>
}

/** Python stats worker (scipy authoritative) — HTTP /analyze. */
class PythonStatsEngine implements StatsEngine {
  constructor(private baseUrl: string) {}

  async analyze(input: StatsInput): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`stats worker HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const json = (await res.json()) as { report?: Record<string, unknown> }
    if (!json?.report || typeof json.report !== 'object') {
      throw new Error('stats worker returned no report')
    }
    return json.report
  }
}

/** Pure-TS fallback — delegates to the deterministic stat-tools. */
class TypeScriptStatsEngine implements StatsEngine {
  async analyze(input: StatsInput): Promise<Record<string, unknown>> {
    const { StatDescribeTool, StatTTestTool, StatChiSqTool, StatKmTool } = await import('./stat-tools.js')
    let res
    switch (input.test) {
      case 'describe':
        res = await new StatDescribeTool().execute({ values: input.values || [] })
        break
      case 't-test':
        res = await new StatTTestTool().execute({ group_a: input.group_a || [], group_b: input.group_b || [] })
        break
      case 'chi-square':
        res = await new StatChiSqTool().execute({ table: input.table || [] })
        break
      case 'kaplan-meier':
        res = await new StatKmTool().execute({ group_a: input.survival_a || [], group_b: input.survival_b || [] })
        break
      default:
        throw new Error(`Unsupported test: ${input.test}`)
    }
    if (!res.success) throw new Error(res.error || 'stats analysis failed')
    return JSON.parse(res.output!) as Record<string, unknown>
  }
}

let cachedEngine: StatsEngine | null = null

/**
 * Create (or reuse) the configured stats engine. STATS_WORKER_URL routes to
 * the Python worker; otherwise the TS fallback runs in-process. Env is read
 * lazily so tests can stub it.
 */
export function createStatsEngine(): StatsEngine {
  const url = process.env.STATS_WORKER_URL
  if (url) {
    cachedEngine = new PythonStatsEngine(url)
  } else {
    cachedEngine = new TypeScriptStatsEngine()
  }
  return cachedEngine
}

/** Test hook. */
export function setStatsEngineForTest(engine: StatsEngine | null): void {
  cachedEngine = engine
}
