/**
 * Statistics worker contract (#689) — the request/response shapes shared
 * between server-ts (producer) and python-stats-worker (scipy consumer).
 *
 * Field names are snake_case on the wire. python-stats-worker/main.py
 * mirrors this schema with an isomorphic pydantic model — keep both in sync.
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

/** Loose report shape — each test returns a different report object. */
export const statsReportSchema = z.record(z.string(), z.unknown())
export type StatsReport = z.infer<typeof statsReportSchema>

export const statsResponseSchema = z.object({
  report: statsReportSchema,
})
export type StatsResponse = z.infer<typeof statsResponseSchema>
