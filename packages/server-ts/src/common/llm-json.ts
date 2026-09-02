/**
 * #683 — unified LLM-output JSON parsing.
 *
 * Every LLM extraction path used to roll its own tolerance (fence-stripping,
 * region slicing, error semantics) — six+ variants with subtly different
 * behaviour. `parseLlmJson` is the single entry point for "the model returned
 * text; I want the JSON object/array it described":
 *
 *   1. direct parse (fast path)
 *   2. strip ```json / ``` fences
 *   3. balanced-region extraction of the first `{…}` or `[…]` (string-literal
 *      aware), trying whichever opens earliest first
 *
 * Returns null when nothing parses. DB-backed JSON (Prisma string columns)
 * uses `parseDbJson` instead — those never contain model chatter, so the
 * tolerance layers only add masking.
 */

function findBalancedRegion(s: string, open: string, close: string, from: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false
  let start = -1
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; continue }
    if (c === open) {
      if (depth === 0) start = i
      depth++
    } else if (c === close) {
      depth--
      if (depth === 0 && start >= 0) return s.slice(start, i + 1)
    }
  }
  return null
}

/** Parse LLM output as JSON with uniform tolerance; null when unparseable. */
export function parseLlmJson<T = unknown>(raw: string | null | undefined): T | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  try { return JSON.parse(trimmed) as T } catch { /* fall through */ }

  const fenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  if (fenced !== trimmed) {
    try { return JSON.parse(fenced) as T } catch { /* fall through */ }
  }

  const candidates: Array<{ at: number; text: string }> = []
  const braceAt = fenced.indexOf('{')
  const bracketAt = fenced.indexOf('[')
  if (braceAt >= 0) {
    const r = findBalancedRegion(fenced, '{', '}', braceAt)
    if (r) candidates.push({ at: braceAt, text: r })
  }
  if (bracketAt >= 0) {
    const r = findBalancedRegion(fenced, '[', ']', bracketAt)
    if (r) candidates.push({ at: bracketAt, text: r })
  }
  candidates.sort((a, b) => a.at - b.at)
  for (const c of candidates) {
    try { return JSON.parse(c.text) as T } catch { /* try next */ }
  }
  return null
}

/** Parse a JSON string persisted by our own code (Prisma columns, etc.). */
export function parseDbJson<T = Record<string, unknown>>(text: string | null | undefined): T | undefined {
  if (!text) return undefined
  try { return JSON.parse(text) as T } catch { return undefined }
}

/**
 * #694 — array-shaped LLM output. Several extractors ask the model for a
 * bare JSON array; models still fence them or wrap in prose. Returns the
 * array when the output parses to one, an object's `items`-style array
 * field is NOT auto-unwrapped here (callers decide — practitioner uses
 * `{observations}` while distiller expects a bare array), null otherwise.
 */
export function parseLlmJsonArray<T = unknown>(raw: string | null | undefined): T[] | null {
  const parsed = parseLlmJson<unknown>(raw)
  return Array.isArray(parsed) ? (parsed as T[]) : null
}
