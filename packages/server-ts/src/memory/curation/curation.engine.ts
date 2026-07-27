import type { MemoryGraph } from '../memory.graph'
import type { CurationPolicy, FactNode, ArticleNode, DocumentNode } from '../memory.types'
import { DEFAULT_CURATION_POLICY } from '../memory.types'

export interface PropagationResult {
  staleArticleStableIds: string[]
  supersededFactStableIds: string[]
  reopenedGapStableIds: string[]
}

export class CurationEngine {
  constructor(
    private graph: MemoryGraph,
    private policy: CurationPolicy = DEFAULT_CURATION_POLICY,
  ) {}

  /** Called after a fact is edited or soft-deleted. */
  propagateFactChange(factStableId: string): PropagationResult {
    const result: PropagationResult = {
      staleArticleStableIds: [],
      supersededFactStableIds: [],
      reopenedGapStableIds: [],
    }

    const fact = this.graph.getLatestByStableId(factStableId) as FactNode | undefined
    if (!fact) return result

    // Collect dependents across all versions of this fact
    const versionIds = this.graph.getVersions(factStableId).map(v => v.id)
    const dependentNodeIds = Array.from(new Set(versionIds.flatMap(id => this.graph.getDependents(id))))
    for (const articleNodeId of dependentNodeIds) {
      const article = this.graph.getNode(articleNodeId) as ArticleNode | undefined
      if (!article) continue
      if (article.status === 'superseded') continue

      this.graph.markStatus(articleNodeId, 'stale')
      const staleBecause = new Set(article.staleBecause || [])
      staleBecause.add(factStableId)
      this.graph.updateNode(articleNodeId, {
        staleBecause: Array.from(staleBecause),
      } as Partial<ArticleNode>)
      result.staleArticleStableIds.push(article.stableId)

      // If the article now has zero current/replaced sources, supersede it.
      // A source that was edited still counts because a newer version exists.
      const currentDeps = this.countCurrentDependencies(articleNodeId)
      if (currentDeps === 0) {
        this.graph.markStatus(articleNodeId, 'superseded')
      }
    }

    // Re-open gaps that were answered by any version of this fact if the fact is now superseded
    if (fact.status === 'superseded') {
      const answerRelations = versionIds
        .flatMap(id => this.graph.getRelationsTo(id).filter(r => r.relation === 'answers'))
      for (const rel of answerRelations) {
        const gap = this.graph.getNode(rel.sourceId)
        if (gap && gap.type === 'gap' && gap.status !== 'superseded') {
          this.graph.markStatus(rel.sourceId, 'current')
          result.reopenedGapStableIds.push(gap.stableId)
        }
      }
    }

    return result
  }

  /** Called after a document is soft-deleted. */
  propagateDocumentDelete(documentStableId: string): PropagationResult {
    const result: PropagationResult = {
      staleArticleStableIds: [],
      supersededFactStableIds: [],
      reopenedGapStableIds: [],
    }

    const document = this.graph.getLatestByStableId(documentStableId) as DocumentNode | undefined
    if (!document) return result

    const derivedFacts = this.graph.getRelationsFrom(document.id)
      .filter(r => r.relation === 'derives_from')
      .map(r => this.graph.getNode(r.targetId))
      .filter((n): n is FactNode => n?.type === 'fact')

    for (const fact of derivedFacts) {
      if (fact.status === 'superseded') continue
      this.graph.markStatus(fact.id, 'superseded')
      result.supersededFactStableIds.push(fact.stableId)

      const sub = this.propagateFactChange(fact.stableId)
      result.staleArticleStableIds.push(...sub.staleArticleStableIds)
      result.reopenedGapStableIds.push(...sub.reopenedGapStableIds)
    }

    this.graph.markStatus(document.id, 'superseded')
    return result
  }

  private countCurrentDependencies(articleNodeId: string): number {
    return this.graph
      .getRelationsFrom(articleNodeId)
      .filter(r => r.relation === 'depends_on')
      .map(r => this.graph.getNode(r.targetId))
      .filter(n => {
        if (!n) return false
        if (n.status !== 'superseded') return true
        // A superseded dependency still counts if a newer current version of the same entity exists
        const latest = this.graph.getLatestByStableId(n.stableId)
        return latest !== undefined && latest.status !== 'superseded'
      }).length
  }
}
