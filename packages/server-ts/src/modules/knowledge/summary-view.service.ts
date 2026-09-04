/**
 * Summary view serialization (#687) — moved out of knowledge.router.ts so
 * the HTTP layer only maps requests; this is the single shape both the
 * list and detail endpoints (and the regenerate endpoint) return.
 */
import type { SummaryNode, FactNode } from '../../memory/memory.types.js'
import type { MemoryService } from '../../memory/memory.service'

export function serializeSummary(summary: SummaryNode, memory: MemoryService) {
  const impact = (summary.staleBecause || []).map(factStableId => {
    const fact = memory.graph.getLatestByStableId(factStableId) as FactNode | undefined
    return {
      factId: factStableId,
      status: fact?.status || 'unknown',
      content: fact?.content || '',
      message: `依赖的 Fact ${factStableId} 已更新`,
    }
  })

  return {
    id: summary.stableId,
    title: summary.title,
    content: summary.content,
    status: summary.status,
    version: summary.version,
    sources: summary.sourceFacts.map(s => s.stableId),
    staleBecause: summary.staleBecause || [],
    impact,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  }
}
