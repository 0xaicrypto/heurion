/**
 * §5.4 (#197): unified attention/recency primitives — one time base
 * (milliseconds), one recency curve, one attention formula.
 */

export function daysAgo(timestamp?: number): number {
  if (!timestamp) return 999
  return (Date.now() - timestamp) / (1000 * 60 * 60 * 24)
}

export function recencyWeight(days: number, lambda = 0.3): number {
  return Math.exp(-lambda * days)
}

export interface AttentionItem {
  importance: number
  lastSeenAt?: number
  count?: number
}

/** #627: 单一 importance 倍率实现 — 1→1.0, 5→2.2。所有调用方
 *  (attentionScore / projection layer3)统一从这里取,不再各自手写。 */
export function importanceMultiplier(importance = 3): number {
  return 1 + (importance - 1) * 0.3
}

/** Attention score: importance × recency × observation count. */
export function attentionScore(item: AttentionItem, now = Date.now()): number {
  const days = Math.max(0, (now - (item.lastSeenAt || now)) / 86400_000)
  const recency = recencyWeight(days, 0.3) // ~74% at 1 day, ~12% at 7 days
  return recency * importanceMultiplier(item.importance) * (item.count || 1)
}

/** Rank items by attention score, return top N. */
export function rankByAttention<T extends AttentionItem>(items: T[], limit = 20): T[] {
  const now = Date.now()
  return items
    .map(item => ({ item, score: attentionScore(item, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.item)
}
