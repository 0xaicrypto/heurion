/**
 * #901: legal job types at the worker enqueue entry — unknown types must be
 * rejected with HTTP 400 BEFORE a job record is created (the old path
 * enqueued first and then failed with an undefined handler).
 *
 * The set is the contracts renderJobType enum, which is the same set as the
 * server.ts HANDLERS keys (HANDLERS is a compile-time exhaustive
 * Record<RenderJobType, …>). No plugin-namespace job types are registered on
 * the worker (#766: third-party plugins' legacy `sidecar.<pluginId>.<tool>`
 * form is unknown to the worker either way), so plugins:render types only.
 */
import { renderJobType, type RenderJobType } from '@heurion/contracts'

export const KNOWN_JOB_TYPES: readonly string[] = renderJobType.options

export function isKnownJobType(type: string): type is RenderJobType {
  return KNOWN_JOB_TYPES.includes(type)
}
