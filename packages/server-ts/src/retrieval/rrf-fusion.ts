/**
 * P7 — RRF (Reciprocal Rank Fusion)
 *
 * Merges ranked results from multiple retrieval sources (SQL, vector, graph).
 * RRF formula: score = Σ(1 / (k + rank)) where k=60 (industry standard).
 */

export interface RrfCandidate {
  content: string
  source: 'sql' | 'vector' | 'graph'
  sourceId: string
  rank: number
}

export interface MergedResult {
  content: string
  sources: string[]
  sourceIds: string[]
  score: number
}

const RRF_K = 60

/**
 * Merge multiple ranked lists using Reciprocal Rank Fusion.
 * Deduplicates by content, summing scores for duplicate entries.
 */
export function rrfFusion(resultLists: RrfCandidate[][], topK = 20): MergedResult[] {
  if (resultLists.length === 0 || resultLists.every(l => l.length === 0)) return []

  const scoreMap = new Map<string, { content: string; sources: Set<string>; sourceIds: Set<string>; score: number }>()

  for (const list of resultLists) {
    for (const item of list) {
      const key = item.content.slice(0, 80).toLowerCase()
      const existing = scoreMap.get(key)
      if (existing) {
        existing.sources.add(item.source)
        existing.sourceIds.add(item.sourceId)
        existing.score += 1 / (RRF_K + item.rank)
      } else {
        scoreMap.set(key, {
          content: item.content,
          sources: new Set([item.source]),
          sourceIds: new Set([item.sourceId]),
          score: 1 / (RRF_K + item.rank),
        })
      }
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(m => ({
      content: m.content,
      sources: Array.from(m.sources),
      sourceIds: Array.from(m.sourceIds),
      score: Math.round(m.score * 1000) / 1000,
    }))
}
