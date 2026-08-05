import prisma from '../common/prisma.js'

/**
 * 13.4F — extraction quality feedback.
 *
 * Acceptance rate per category over the last 7 days (resolved proposals
 * only). The extraction prompt injects dynamic guidance based on it:
 *   - rate < 30%   → "this category has many false positives — be stricter"
 *   - rate > 90%   → "this category is usually accepted — output can be more
 *     complete" (only when there are enough samples to be meaningful)
 */

export interface CategoryQuality {
  category: string
  accepted: number
  rejected: number
  rate: number
}

export async function getCategoryQuality(userId: string, days = 7): Promise<CategoryQuality[]> {
  const since = new Date(Date.now() - days * 86400_000).toISOString()
  const rows = await (prisma as any).memoryProposal.findMany({
    where: {
      userId,
      status: { in: ['approved', 'rejected'] },
      resolvedAt: { not: null },
      category: { not: null },
    },
    select: { category: true, status: true },
  })
  const stats = new Map<string, { accepted: number; rejected: number }>()
  for (const r of rows) {
    const c = r.category as string
    const s = stats.get(c) ?? { accepted: 0, rejected: 0 }
    if (r.status === 'approved') s.accepted++
    else s.rejected++
    stats.set(c, s)
  }
  const out: CategoryQuality[] = []
  for (const [category, s] of stats) {
    const total = s.accepted + s.rejected
    if (total === 0) continue
    out.push({ category, accepted: s.accepted, rejected: s.rejected, rate: s.accepted / total })
  }
  return out.sort((a, b) => b.rejected - a.rejected)
}

/** Builds the dynamic prompt rules segment from quality stats. */
export function buildQualityGuidance(quality: CategoryQuality[]): string {
  if (quality.length === 0) return ''
  const lines: string[] = []
  for (const q of quality) {
    const total = q.accepted + q.rejected
    if (q.rate < 0.3 && total >= 3) {
      lines.push(`- "${q.category}" 类近期误报较多（${q.accepted}/${total} 被接受）——请更严格，只输出确凿信息`)
    } else if (q.rate > 0.9 && total >= 5) {
      lines.push(`- "${q.category}" 类通常被接受（${q.accepted}/${total}）——可以更完整地输出该类别`)
    }
  }
  if (lines.length === 0) return ''
  return `\nQuality feedback (recent acceptance rates):\n${lines.join('\n')}\n`
}
