import prisma from '../common/prisma.js'

/**
 * K1 — incremental extraction cursor (BRAIN2_MEMORY_LIFECYCLE §5.1).
 *
 * Each scope (patient / global) persists the event idx up to which facts
 * have been extracted. Extraction pipelines read only the incremental event
 * segment (afterIdx → latest], avoiding both short-session misses (no fixed
 * turn-count gate) and long-session re-extraction.
 *
 * S1: real-time extraction is removed — the cursor advances only at
 * compaction time (Tier 2) and session close (Tier 3), where segments are
 * processed once with full context.
 */

export interface ExtractionCursorKey {
  userId: string
  scopeType: 'patient' | 'global' | 'study'
  patientHash?: string
  studyId?: string
}

export function scopeKeyOf(key: ExtractionCursorKey): string {
  return [key.userId, key.scopeType, key.patientHash || '', key.studyId || ''].join(':')
}

export async function getExtractedUptoIdx(key: ExtractionCursorKey): Promise<number> {
  const row = await (prisma as any).kbExtractCursor.findUnique({
    where: {
      userId_scopeType_patientHash: {
        userId: key.userId,
        scopeType: key.scopeType,
        patientHash: key.patientHash || '',
      },
    },
  })
  return row?.extractedUptoIdx ?? 0
}

export async function advanceExtractedUptoIdx(key: ExtractionCursorKey, idx: number): Promise<void> {
  const now = new Date().toISOString()
  await (prisma as any).kbExtractCursor.upsert({
    where: {
      userId_scopeType_patientHash: {
        userId: key.userId,
        scopeType: key.scopeType,
        patientHash: key.patientHash || '',
      },
    },
    update: { extractedUptoIdx: idx, updatedAt: now },
    create: {
      userId: key.userId,
      scopeType: key.scopeType,
      patientHash: key.patientHash || '',
      extractedUptoIdx: idx,
      updatedAt: now,
    },
  })
}


