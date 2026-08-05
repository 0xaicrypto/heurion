import prisma from '../common/prisma.js'

/**
 * K1 — incremental extraction cursor (BRAIN2_MEMORY_LIFECYCLE §5.1).
 *
 * Cursors are PER-SESSION (#181): interleaved writes across sessions must
 * never let one session's flush skip another session's events. The legacy
 * scope-level key (sessionId = '') is preserved for backward compatibility.
 *
 * S1: real-time extraction is removed — the cursor advances only at
 * compaction time (Tier 2) and session close (Tier 3).
 */

export interface ExtractionCursorKey {
  userId: string
  scopeType: 'patient' | 'global' | 'study'
  patientHash?: string
  studyId?: string
  /** Per-session cursor key — '' falls back to scope-level. */
  sessionId?: string
}

export function scopeKeyOf(key: ExtractionCursorKey): string {
  return [key.userId, key.scopeType, key.patientHash || '', key.studyId || '', key.sessionId || ''].join(':')
}

function whereOf(key: ExtractionCursorKey) {
  return {
    userId_scopeType_patientHash_sessionId: {
      userId: key.userId,
      scopeType: key.scopeType,
      patientHash: key.patientHash || '',
      sessionId: key.sessionId || '',
    },
  }
}

export async function getExtractedUptoIdx(key: ExtractionCursorKey): Promise<number> {
  const row = await (prisma as any).kbExtractCursor.findUnique({ where: whereOf(key) })
  return row?.extractedUptoIdx ?? 0
}

export async function advanceExtractedUptoIdx(key: ExtractionCursorKey, idx: number): Promise<void> {
  const now = new Date().toISOString()
  const where = whereOf(key)
  const existing = await (prisma as any).kbExtractCursor.findUnique({ where })
  if (existing && existing.extractedUptoIdx >= idx) {
    // Never regress the cursor (concurrent sessions / stale writes).
    return
  }
  await (prisma as any).kbExtractCursor.upsert({
    where,
    update: { extractedUptoIdx: idx, updatedAt: now },
    create: {
      userId: key.userId,
      scopeType: key.scopeType,
      patientHash: key.patientHash || '',
      sessionId: key.sessionId || '',
      extractedUptoIdx: idx,
      updatedAt: now,
    },
  })
}
