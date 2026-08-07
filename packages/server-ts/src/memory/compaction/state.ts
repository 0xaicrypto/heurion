import { makeLogger } from '../../common/logger.js'
import { runSessionCompaction } from './runner.js'
import type { CompactionCtx } from './budget.js'

/**
 * #353: per-session in-flight guard — compaction is an async side-effect of
 * a turn, never re-entrant, and fires at most once per covered segment.
 */
const inFlight = new Map<string, Promise<void>>()
const log = makeLogger('compaction')

/**
 * Returns the in-flight compaction promise for a session, or null when none
 * is running. Used for opencode-style delayed-sync: a turn that arrives
 * while the previous compaction is still running awaits it before replying,
 * so the anchored summary is always injectable.
 */
export function getInFlightCompaction(userId: string, sessionId: string): Promise<void> | null {
  return inFlight.get(`${userId}:${sessionId}`) ?? null
}

/**
 * R2 — entry point called from the chat router when the session budget
 * overflows (omitted turns) or the turn window is full. Compacts the dropped
 * segment [coveredUptoIdx, firstRetainedIdx) if it contains enough content.
 */
export function ensureSessionCompaction(
  ctx: CompactionCtx,
  sessionId: string,
  firstRetainedIdx: number,
  patientHash?: string,
): Promise<void> {
  const key = `${ctx.userId}:${sessionId}`
  if (inFlight.has(key)) return inFlight.get(key)!
  const p = runSessionCompaction(ctx, sessionId, firstRetainedIdx, patientHash)
    .catch((err: any) => log.error('compaction failed', { reason: (err as Error).message.slice(0, 120) }))
    .finally(() => inFlight.delete(key))
  inFlight.set(key, p)
  return p
}
