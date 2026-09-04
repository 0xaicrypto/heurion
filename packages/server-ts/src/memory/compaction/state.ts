import { makeLogger } from '../../common/logger.js'
import { runSessionCompaction, type CompactionOutcome } from './runner.js'
import type { CompactionCtx } from './budget.js'

/**
 * #353: per-session in-flight guard — compaction is an async side-effect of
 * a turn, never re-entrant, and fires at most once per covered segment.
 */
const inFlight = new Map<string, Promise<CompactionOutcome>>()
const log = makeLogger('compaction')

/**
 * Returns the in-flight compaction promise for a session, or null when none
 * is running. Used for opencode-style delayed-sync: a turn that arrives
 * while the previous compaction is still running awaits it before replying,
 * so the anchored summary is always injectable.
 */
export function getInFlightCompaction(userId: string, sessionId: string): Promise<CompactionOutcome> | null {
  return inFlight.get(`${userId}:${sessionId}`) ?? null
}

/**
 * R2 — entry point called from the chat router when the session budget
 * overflows (omitted turns) or the turn window is full. Compacts the dropped
 * segment [coveredUptoIdx, firstRetainedIdx) if it contains enough content.
 * #display: resolves with a CompactionOutcome — failures are logged but
 * surfaced as kind:'failed' so the completion reporter can tell the user
 * what happened (此前失败被吞,压缩对用户完全不可见)。
 */
export function ensureSessionCompaction(
  ctx: CompactionCtx,
  sessionId: string,
  firstRetainedIdx: number,
  patientHash?: string,
): Promise<CompactionOutcome> {
  const key = `${ctx.userId}:${sessionId}`
  if (inFlight.has(key)) return inFlight.get(key)!
  const p = runSessionCompaction(ctx, sessionId, firstRetainedIdx, patientHash)
    .catch((err: any): CompactionOutcome => {
      log.error('compaction failed', { reason: (err as Error).message.slice(0, 120) })
      return { kind: 'failed', summary: '', prevCoveredIdx: 0, coveredIdx: 0, events: 0 }
    })
    .finally(() => inFlight.delete(key))
  inFlight.set(key, p)
  return p
}
