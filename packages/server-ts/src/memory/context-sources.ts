import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

/**
 * R1 — typed context sources (BRAIN2_MEMORY_LIFECYCLE §4.3, #98).
 *
 * The system prompt is composed of stable per-source segments. Each segment
 * carries a content hash; a persisted per-user snapshot lets callers know
 * which segments changed (and which were removed) between turns.
 *
 * Stable segments → byte-stable system prompts → provider prompt-cache hits,
 * and persona segments update independently (13.5H) instead of rebuilding
 * the whole persona on any fact change.
 */

export interface ContextSegment {
  key: string
  text: string
}

export interface SegmentState extends ContextSegment {
  hash: string
}

export interface SourceDiff {
  changed: string[]
  removed: string[]
}

export function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export function snapshotPath(userId: string): string {
  return path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'context-snapshot.json')
}

/** Load the persisted snapshot. Corrupt/missing → null (full rebuild). */
export function loadSnapshot(userId: string): Record<string, SegmentState> | null {
  try {
    const raw = fs.readFileSync(snapshotPath(userId), 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, SegmentState>
  } catch {
    return null
  }
}

export function saveSnapshot(userId: string, state: Record<string, SegmentState>): void {
  try {
    fs.mkdirSync(path.dirname(snapshotPath(userId)), { recursive: true })
    fs.writeFileSync(snapshotPath(userId), JSON.stringify(state), 'utf-8')
  } catch {
    // snapshot persistence is best-effort
  }
}

/**
 * Compute the next segment state. Sources that fail to load keep their
 * previous snapshot value (never treated as removed).
 */
export function computeSegments(
  userId: string,
  current: ContextSegment[],
  prev: Record<string, SegmentState> | null,
): { state: Record<string, SegmentState>; diff: SourceDiff } {
  const next: Record<string, SegmentState> = {}
  const diff: SourceDiff = { changed: [], removed: [] }
  const seen = new Set<string>()

  for (const seg of current) {
    seen.add(seg.key)
    const hash = hashText(seg.text)
    const old = prev?.[seg.key]
    if (!old || old.hash !== hash) {
      diff.changed.push(seg.key)
      next[seg.key] = { key: seg.key, text: seg.text, hash }
    } else {
      // Unchanged — keep the previous text (stable, cache-friendly).
      next[seg.key] = old
    }
  }

  if (prev) {
    for (const key of Object.keys(prev)) {
      if (!seen.has(key)) diff.removed.push(key)
    }
  }
  return { state: next, diff }
}

/** Render segments into the system prompt (base + stable segments). */
export function renderSystemPrompt(base: string, state: Record<string, SegmentState>): string {
  const parts = [base]
  for (const seg of Object.values(state)) {
    if (seg.text.trim()) parts.push(seg.text.trim())
  }
  return parts.join('\n\n')
}

/** Removal renderer — marks a vanished source (kept in the diff, visible to tests). */
export function renderRemoval(keys: string[]): string {
  return keys.length > 0 ? `[Context source removed: ${keys.join(', ')}]` : ''
}
