import prisma from '../common/prisma.js'

/**
 * K1 — incremental extraction cursor (BRAIN2_MEMORY_LIFECYCLE §5.1).
 *
 * Each scope (patient / global) persists the event idx up to which facts
 * have been extracted. Extraction pipelines read only the incremental event
 * segment (afterIdx → latest], avoiding both short-session misses (no fixed
 * turn-count gate) and long-session re-extraction.
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

/**
 * K2 — event-driven trigger decision (Tier 1). Triggered ONLY by explicit
 * memory instructions or safety-critical signals. Everything else is
 * extracted at compaction time (Tier 2) or session close (Tier 3), where
 * segments are processed once with full context — real-time extraction is
 * intentionally near-zero (diagnosis/plan/start words are far too common in
 * clinical conversation to trigger).
 */
export function shouldExtractIncrement(incrementalText: string): boolean {
  // Explicit memory instructions + safety-critical allergies/contraindications.
  const SIGNALS = /记住|记得|保存到知识库|保存记忆|过敏|禁忌/
  return SIGNALS.test(incrementalText)
}
