/**
 * P4 — Context Compressor
 *
 * Three-level compression pipeline:
 *   1. rankByAttention: importance × recency, top-N
 *   2. Compact representation: facts → condensed sentences
 *   3. Deduplication: same entity repeated → merged
 *
 * Target: 53% token reduction while maintaining semantics.
 */
import type { Fact } from '../evolution/stores'

/** Attention score: importance × e^(-0.3 × daysAgo) */
function attentionScore(fact: Fact, now: number): number {
  const daysAgo = Math.max(0, (now - fact.lastSeenAt) / 86400_000)
  const recency = Math.exp(-0.3 * daysAgo)  // ~74% at 1 day, ~12% at 7 days
  const importanceMultiplier = 1 + (fact.importance - 1) * 0.3 // 1→1.0, 5→2.2
  return recency * importanceMultiplier * (fact.count || 1)
}

/**
 * Rank facts by attention score, return top N.
 */
export function rankByAttention<T extends { importance: number; lastSeenAt: number; count?: number }>(
  items: T[],
  limit = 20,
): T[] {
  const now = Date.now()
  return items
    .map(item => ({ item, score: attentionScore(item as any, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.item)
}

/**
 * Deduplicate clinical findings by merging same entity across time.
 * "RUL nodule 18mm (CT 4/10)" + "RUL nodule 18mm (CT 7/15)" → "RUL nodule: 18mm (2 scans)"
 */
export function deduplicateFindings(findings: string[]): string[] {
  if (findings.length === 0) return []

  const entityMap = new Map<string, { value: string; count: number; dates: string[] }>()

  for (const f of findings) {
    // Extract entity name (before first parenthesis or colon)
    const entity = f.split(/[(:]/)[0].trim().toLowerCase()
    const existing = entityMap.get(entity)
    if (existing) {
      existing.count++
      const dateMatch = f.match(/\(([^)]+)\)/)
      if (dateMatch) existing.dates.push(dateMatch[1])
    } else {
      const dateMatch = f.match(/\(([^)]+)\)/)
      entityMap.set(entity, {
        value: entity.replace(/\b\w/g, c => c.toUpperCase()),
        count: 1,
        dates: dateMatch ? [dateMatch[1]] : [],
      })
    }
  }

  return Array.from(entityMap.entries()).map(([key, info]) => {
    if (info.count > 1) {
      return `${info.value}: ${findings.find(f => f.toLowerCase().startsWith(key))?.match(/\d+[a-z]*\s*(?:mm|cm|mg|ng)?/i)?.[0] || ''} (${info.count} scans)`
    }
    return findings.find(f => f.toLowerCase().startsWith(key)) || info.value
  })
}

/**
 * Compact context: rank → compact → dedup.
 * Returns a concise string for LLM context injection.
 */
export function compactContext(
  facts: Fact[],
  knowledgeTitles: string[],
  fileNames: string[],
): string {
  const parts: string[] = []
  const ranked = rankByAttention(facts, 20)

  // Preferences first (highest personalization value)
  const prefs = ranked.filter(f => f.category === 'preference')
  if (prefs.length > 0) {
    parts.push('Preferences: ' + prefs.map(p => p.content).join('; '))
  }

  // Goals
  const goals = ranked.filter(f => f.category === 'goal').slice(0, 3)
  if (goals.length > 0) {
    parts.push('Goals: ' + goals.map(g => g.content).join('; '))
  }

  // Key facts — dedup by entity
  const keyFacts = ranked.filter(f => f.category === 'fact').slice(0, 10)
  const factStrings = keyFacts.map(f => f.content)
  const deduped = deduplicateFindings(factStrings)

  if (deduped.length > 0) {
    parts.push('Key findings: ' + deduped.join(' | '))
  }

  // Knowledge articles (titles only for compactness)
  if (knowledgeTitles.length > 0) {
    parts.push('Knowledge: ' + knowledgeTitles.slice(0, 5).join(', '))
  }

  // Files
  if (fileNames.length > 0) {
    parts.push('Files: ' + fileNames.slice(0, 5).join(', '))
  }

  return parts.join('\n')
}
