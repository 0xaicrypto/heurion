/**
 * Statistics worker contract (#689) — the request/response shapes shared
 * between server-ts (producer) and python-stats-worker (scipy consumer).
 *
 * Field names are snake_case on the wire. python-stats-worker/main.py
 * mirrors this schema with an isomorphic pydantic model — keep both in sync
 * (scripts/check-stats-schema-alignment.sh is the machine-readable check).
 *
 * Report shape (#1109): polymorphic per test, but closed — both engines
 * (python-stats-worker stats_core.py authoritative / TS fallback stat-tools)
 * return exactly one of the variants below, discriminated by `method`.
 * Extending the union = add the variant here AND the mirrored branch in
 * stats_core.py + stat-tools.ts in the same change.
 *
 * Intentionally loose (documented tolerance, not omissions):
 * - `gating` (t-test family) — python always emits it for t-test, the TS
 *   fallback only attaches it on the normality-degradation path, so it is
 *   optional. Shape typed; presence not enforced.
 * - kaplan-meier `effect_size` — python emits null, TS omits the key.
 * - kaplan-meier `median_survival_a/b` — TS-only extra (number|null), kept
 *   optional so the python-authoritative shape still validates.
 * - Unknown extra keys pass (zod default non-strict) — additive engine
 *   fields don't need a contracts release, wrong types / missing required
 *   keys still fail loudly.
 */
import { z } from 'zod'

export const statsRequestSchema = z.object({
  test: z.string().min(1),
  group_a: z.array(z.number()).optional(),
  group_b: z.array(z.number()).optional(),
  table: z.array(z.array(z.number())).optional(),
  values: z.array(z.number()).optional(),
  survival_a: z.array(z.object({ time: z.number(), event: z.boolean() })).optional(),
  survival_b: z.array(z.object({ time: z.number(), event: z.boolean() })).optional(),
  // two-way-anova factors (stats_core.two_way_anova)
  group: z.array(z.string()).optional(),
  factor_a: z.array(z.string()).optional(),
})
export type StatsRequest = z.infer<typeof statsRequestSchema>

/**
 * Reports round floats before serialization (python to 6 decimals, TS to 4-6);
 * z.number() rejects NaN/Infinity by design — a NaN report means engine math
 * degenerated and failing loudly is the wanted behaviour.
 */
const statNumber = z.number()
/** Every completed inferential report carries a human-readable interpretation line. */
const interpretation = z.string().min(1)

/** Normality gating metadata (t-test family, #405). */
export const statsGatingSchema = z.object({
  normality_gate: z.enum(['passed', 'failed']),
  auto_degraded_to: z.string().optional(),
  declared: z.boolean().optional(),
})

/* ── per-test variants (stats_core.py ↔ stat-tools.ts mirrored) ────────── */

/** describe → stats_core.describe / StatDescribeTool (no interpretation line). */
export const statsDescribeReportSchema = z.object({
  method: z.literal('descriptive'),
  n: z.number().int().min(0),
  mean: statNumber,
  median: statNumber,
  sd: statNumber,
  q1: statNumber,
  q3: statNumber,
  min: statNumber,
  max: statNumber,
})

/** t-test normal path → welch_t (Welch–Satterthwaite df + mean-diff CI). */
export const statsWelchTReportSchema = z.object({
  method: z.literal('welch_t'),
  test_stat: statNumber,
  df: statNumber,
  p_value: statNumber,
  effect_size: statNumber,
  ci_95: z.tuple([statNumber, statNumber]),
  interpretation,
  gating: statsGatingSchema.optional(),
})

/** t-test degradation path (#405 normality gate) → Mann-Whitney. */
export const statsMannWhitneyReportSchema = z.object({
  method: z.literal('mann_whitney'),
  test_stat: statNumber,
  p_value: statNumber,
  effect_size: statNumber,
  interpretation,
  gating: statsGatingSchema.optional(),
})

/** chi-square → chisq (Cramér's V effect size). */
export const statsChiSquareReportSchema = z.object({
  method: z.literal('chisq'),
  test_stat: statNumber,
  df: z.number().int(),
  p_value: statNumber,
  effect_size: statNumber,
  interpretation,
})

/** kaplan-meier → lifelines KM curves + log-rank (effect_size = null). */
export const statsKaplanMeierReportSchema = z.object({
  method: z.literal('kaplan_meier_logrank'),
  test_stat: statNumber,
  p_value: statNumber,
  effect_size: statNumber.nullable().optional(),
  interpretation,
  curve_a: z.array(z.object({ time: statNumber, survival: statNumber })),
  curve_b: z.array(z.object({ time: statNumber, survival: statNumber })),
  // TS fallback extra; python omits it.
  median_survival_a: statNumber.nullable().optional(),
  median_survival_b: statNumber.nullable().optional(),
})

/** two-way-anova → statsmodels ANOVA table (no top-level stat/p). Term keys
 *  come from the fixed formula `y ~ C(g) + C(f) + C(g):C(f)` in
 *  stats_core.two_way_anova — a missing term row throws there before a
 *  report can exist, so the three keys are stable. */
export const statsTwoWayAnovaReportSchema = z.object({
  method: z.literal('two_way_anova'),
  report: z.object({
    'C(g)': z.object({ f: statNumber, p: statNumber }),
    'C(f)': z.object({ f: statNumber, p: statNumber }),
    interaction: z.object({ f: statNumber, p: statNumber }),
  }),
  interpretation,
})

/** Discriminated union on `method` — every engine's report must match one. */
export const statsReportSchema = z.discriminatedUnion('method', [
  statsDescribeReportSchema,
  statsWelchTReportSchema,
  statsMannWhitneyReportSchema,
  statsChiSquareReportSchema,
  statsKaplanMeierReportSchema,
  statsTwoWayAnovaReportSchema,
])
export type StatsReport = z.infer<typeof statsReportSchema>

export const statsResponseSchema = z.object({
  report: statsReportSchema,
})
export type StatsResponse = z.infer<typeof statsResponseSchema>
