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
 * Deduplicate clinical findings by merging same entity across time,
 * keeping every measured value so trends survive (§4.4 #195).
 */
export function deduplicateFindings(findings: string[]): string[] {
  if (findings.length === 0) return []
  const groups = new Map<string, string[]>()

  for (const f of findings) {
    // Extract key: first word(s) before numbers
    const key = f.replace(/\s*\(.*/, '').replace(/\s*\d+.*$/, '').trim().toLowerCase()
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(f)
  }

  const result: string[] = []
  for (const [key, items] of groups) {
    if (items.length === 1) {
      result.push(items[0])
    } else {
      // Keep every measured value — "BP 140/90 → 120/80" shows the trend
      // instead of dropping all but the first reading.
      const values = items
        .map(item => item.match(/\d+(?:\.\d+)?(?:[/.]\d+)?[a-z]*\s*(?:mm|cm|mg|ng|kg|g|mL|L|%|°)?/i)?.[0])
        .filter((v): v is string => Boolean(v))
      const trend = values.length > 0 ? `${key}: ${values.join(' → ')}` : key
      result.push(`${trend} (${items.length} entries)`)
    }
  }
  return result
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

/**
 * Estimate tokens for mixed CJK/Latin text (mirrors memory-projection).
 * English ≈ 4 chars/token, CJK ≈ 1.5 chars/token.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const latinChars = (text.match(/[a-zA-Z0-9\s]/g) || []).length
  const nonLatinChars = text.length - latinChars
  return Math.ceil(latinChars / 4 + nonLatinChars / 1.5)
}

export interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface HistoryBudgetResult {
  messages: HistoryMessage[]
  /** Number of conversation turns that were trimmed because of the budget. */
  omittedTurns: number
  /** Estimated tokens included in the result. */
  tokens: number
}

/**
 * Build the conversation-history messages under a token budget.
 *
 * Events are ordered oldest → newest. We keep the most recent turns first,
 * stop when the budget is exhausted, and report how many earlier turns were
 * omitted so callers can insert a "earlier context omitted" hint.
 *
 * A single oversized message (e.g. one huge user paste) is still included
 * whole — truncating it mid-sentence would destroy meaning; the caller's
 * own max_tokens/output cap is the backstop.
 */
export function buildHistoryMessages(
  events: Array<{ eventType: string; content: string }>,
  options: { maxTokens?: number; maxTurns?: number } = {},
): HistoryBudgetResult {
  const maxTokens = options.maxTokens ?? 8000
  const maxTurns = options.maxTurns ?? 20

  // Newest first, capped at maxTurns (user + assistant = 2 events per turn).
  const newestFirst = events.slice(-maxTurns * 2).reverse()

  const messages: HistoryMessage[] = []
  let tokens = 0
  let omittedTurns = 0
  const totalTurns = Math.ceil(newestFirst.length / 2)

  for (const evt of newestFirst) {
    const role: HistoryMessage['role'] = evt.eventType === 'user_message' ? 'user' : 'assistant'
    const content = evt.content || ''
    const t = estimateTokens(role === 'user' ? `User: ${content}` : `Assistant: ${content}`)
    if (messages.length > 0 && tokens + t > maxTokens) {
      // Budget exhausted — count remaining turns as omitted and stop.
      omittedTurns = totalTurns - Math.ceil(messages.length / 2)
      break
    }
    messages.push({ role, content })
    tokens += t
  }

  if (omittedTurns === 0 && newestFirst.length % 2 === 1) {
    omittedTurns = Math.floor((newestFirst.length - messages.length) / 2)
  }

  return { messages, omittedTurns, tokens }
}
