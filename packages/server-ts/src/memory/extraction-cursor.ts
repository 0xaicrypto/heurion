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
 * K2 — event-driven trigger decision. Returns true when the incremental
 * segment is worth extracting:
 *   a. incremental content length >= threshold (default 300 chars), or
 *   b. contains a key clinical signal (remember/diagnosis/plan/confirm…)
 */
export function shouldExtractIncrement(
  incrementalText: string,
  opts: { minChars?: number } = {},
): boolean {
  const minChars = opts.minChars ?? 300
  if (incrementalText.trim().length >= minChars) return true
  const SIGNALS = /记住|记得|诊断|方案|确认|停止|剂量|调整|停用|开始|复查|过敏|禁忌/i
  return SIGNALS.test(incrementalText)
}
