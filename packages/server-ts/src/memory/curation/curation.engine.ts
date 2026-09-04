import type { MemoryGraph } from '../memory.graph'
import type { FactNode, SummaryNode, DocumentNode } from '../memory.types'
import { resolveSummaryStaleness } from '../staleness.js'

export interface PropagationResult {
  staleSummaryStableIds: string[]
  supersededFactStableIds: string[]
  reopenedGapStableIds: string[]
}

export class CurationEngine {
  constructor(private graph: MemoryGraph) {}

  /** Called after a fact is edited or soft-deleted. */
  propagateFactChange(factStableId: string): PropagationResult {
    const result: PropagationResult = {
      staleSummaryStableIds: [],
      supersededFactStableIds: [],
      reopenedGapStableIds: [],
    }

    const fact = this.graph.getLatestByStableId(factStableId) as FactNode | undefined
    if (!fact) return result

    // Collect dependents across all versions of this fact
    const versionIds = this.graph.getVersions(factStableId).map(v => v.id)
    const dependentNodeIds = Array.from(new Set(versionIds.flatMap(id => this.graph.getDependents(id))))
    for (const summaryNodeId of dependentNodeIds) {
      const summary = this.graph.getNode(summaryNodeId) as SummaryNode | undefined
      if (!summary) continue
      if (summary.status === 'superseded') continue

      // #813: 判定统一走 resolveSummaryStaleness(与注入侧同源)。
      // 事件路径只提供触发时机;引用了编辑后新版本的 summary 不再被误标。
      const staleness = resolveSummaryStaleness(this.graph, summary)
      if (!staleness.stale) continue

      this.graph.markStatus(summaryNodeId, 'stale')
      // staleBecause 保持裸 fact stableId(summary-view/legacy 按裸 id 反查)。
      const staleBecause = new Set(summary.staleBecause || [])
      for (const r of staleness.reasons) staleBecause.add(r.includes(':') ? r.slice(r.indexOf(':') + 1) : r)
      this.graph.updateNode(summaryNodeId, {
        staleBecause: Array.from(staleBecause),
      } as Partial<SummaryNode>)
      result.staleSummaryStableIds.push(summary.stableId)

      // If the summary now has zero current/replaced sources, supersede it.
      // A source that was edited still counts because a newer version exists.
      const currentDeps = this.countCurrentDependencies(summaryNodeId)
      if (currentDeps === 0) {
        this.graph.markStatus(summaryNodeId, 'superseded')
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
      staleSummaryStableIds: [],
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
      result.staleSummaryStableIds.push(...sub.staleSummaryStableIds)
      result.reopenedGapStableIds.push(...sub.reopenedGapStableIds)
    }

    this.graph.markStatus(document.id, 'superseded')
    return result
  }

  private countCurrentDependencies(summaryNodeId: string): number {
    return this.graph
      .getRelationsFrom(summaryNodeId)
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
