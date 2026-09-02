/**
 * Article view serialization (#687) — moved out of knowledge.router.ts so
 * the HTTP layer only maps requests; this is the single shape both the
 * list and detail endpoints (and the regenerate endpoint) return.
 */
import type { ArticleNode, FactNode } from '../../memory/memory.types.js'
import type { MemoryService } from '../../memory/memory.service'

export function serializeArticle(article: ArticleNode, memory: MemoryService) {
  const impact = (article.staleBecause || []).map(factStableId => {
    const fact = memory.graph.getLatestByStableId(factStableId) as FactNode | undefined
    return {
      factId: factStableId,
      status: fact?.status || 'unknown',
      content: fact?.content || '',
      message: `依赖的 Fact ${factStableId} 已更新`,
    }
  })

  return {
    id: article.stableId,
    title: article.title,
    content: article.content,
    status: article.status,
    version: article.version,
    sources: article.sourceFacts.map(s => s.stableId),
    staleBecause: article.staleBecause || [],
    impact,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
  }
}
