/**
 * P6 — Semantic Search
 *
 * Lightweight TF-IDF-based keyword search. Scores by:
 *   1. Exact phrase match (highest)
 *   2. Word overlap count
 *   3. Position weight (early matches score higher)
 *
 * Future: replace with sqlite-vec embeddings for real semantic search.
 */

export interface SearchResult {
  content: string
  score: number
  source?: string  // 'fact' | 'knowledge' | 'file'
  sourceId?: string
}

/** Simple tokenizer: splits on word boundaries, removes short words */
function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 1)
  )
}

/** TF-IDF inspired score (simplified: word overlap / query length) */
function scoreDocument(query: string, document: string): number {
  const queryTokens = tokenize(query)
  if (queryTokens.size === 0) return 0

  const docLower = document.toLowerCase()

  // Exact phrase bonus
  if (docLower.includes(query.toLowerCase())) return 2.0

  let score = 0
  let matchedTokens = 0
  for (const token of queryTokens) {
    const idx = docLower.indexOf(token)
    if (idx !== -1) {
      matchedTokens++
      // Earlier matches score higher (first 100 chars = full weight)
      const posWeight = idx < 100 ? 1.0 : Math.max(0.3, 1 - idx / 500)
      score += posWeight
    }
  }

  // Normalize: matched ratio * average position weight
  return (matchedTokens / queryTokens.size) * (score / Math.max(matchedTokens, 1))
}

/**
 * Search corpus and return top-K results, sorted by relevance.
 */
export function semanticSearch(
  query: string,
  corpus: string[],
  topK = 10,
): SearchResult[] {
  if (!query || corpus.length === 0) return []

  const scored = corpus
    .map((content, i) => ({ content, score: scoreDocument(query, content), sourceId: String(i) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)

  return scored
}

/**
 * Search across Facts + Knowledge content.
 */
export function searchUserKnowledge(
  query: string,
  facts: Array<{ content: string; id: string; category: string }>,
  knowledge: Array<{ title: string; content: string; id: string }>,
  topK = 10,
): SearchResult[] {
  const corpus: Array<{ text: string; source: string; id: string }> = [
    ...facts.map(f => ({ text: f.content, source: 'fact', id: f.id })),
    ...knowledge.map(k => ({ text: k.content || k.title, source: 'knowledge', id: k.id })),
  ]

  if (corpus.length === 0) return []

  const scored = corpus
    .map(c => ({ content: c.text, score: scoreDocument(query, c.text), source: c.source as SearchResult['source'], sourceId: c.id }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)

  return scored
}
