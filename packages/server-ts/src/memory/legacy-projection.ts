/**
 * #304: legacy-store projection — the synchronous mirror of the graph that
 * powers pre-#22 clients (facts store + knowledge store). Every mutation
 * path goes through PropagationCoordinator, which owns the write order.
 */
import type { MemoryGraph } from './memory.graph.js'
import type { FactsStore, KnowledgeStore } from '../evolution/stores.js'

export interface LegacySnapshot {
  facts: Array<Record<string, any>>
  knowledge: Array<Record<string, any>>
}

export class LegacyProjection {
  constructor(
    private legacyFacts: FactsStore,
    private legacyKnowledge: KnowledgeStore,
    private graph: MemoryGraph,
  ) {}

  /** Deep-copy of the legacy stores, taken before provisional writes. */
  snapshot(): LegacySnapshot {
    return {
      facts: JSON.parse(JSON.stringify(this.legacyFacts.all())) as Array<Record<string, any>>,
      knowledge: JSON.parse(JSON.stringify(this.legacyKnowledge.all())) as Array<Record<string, any>>,
    }
  }

  /** Compensating write: restore the pre-mutation legacy state, #192. */
  rollback(snapshot: LegacySnapshot): void {
    this.legacyFacts.replaceAll(snapshot.facts as any)
    this.legacyKnowledge.replaceAll(snapshot.knowledge as any)
    this.legacyFacts.commit()
    this.legacyKnowledge.commit()
    this.graph.reload()
  }

  /**
   * Consistency reconciliation (#192): treat the graph as the source of
   * truth and rebuild the legacy projection from it. Idempotent — no-ops
   * when the stores already agree. Safe to call at startup or on demand.
   */
  reconcile(): { repaired: boolean; factDiff: number; summaryDiff: number } {
    const currentFacts = this.graph.getCurrentNodesByType('fact') as any[]
    const currentSummaries = this.graph.getCurrentNodesByType('summary') as any[]

    const projectedFacts = currentFacts.map((f) => ({
      id: f.stableId,
      category: f.category,
      importance: f.importance ?? 3,
      content: f.content,
      sourceType: (f.sourceType === 'document' ? 'research' : f.sourceType) as any,
      patientHash: f.patientHash,
      studyId: f.studyId,
      count: f.count ?? 1,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      lastSeenAt: f.updatedAt,
    }))

    const projectedSummaries = currentSummaries.map((a) => ({
      id: a.stableId,
      title: a.title,
      content: a.content,
      sources: (a.sourceFacts || []).map((s: any) => s.stableId),
      version: a.version,
      status: 'current' as const,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }))

    const legacyFacts = this.legacyFacts.all()
    const legacySummaries = this.legacyKnowledge.all()

    const factsEqual = legacyFacts.length === projectedFacts.length &&
      legacyFacts.every((f, i) => f.id === projectedFacts[i].id && f.content === projectedFacts[i].content && f.category === projectedFacts[i].category)
    const summariesEqual = legacySummaries.length === projectedSummaries.length &&
      legacySummaries.every((a, i) => a.id === projectedSummaries[i].id && a.title === projectedSummaries[i].title && a.content === projectedSummaries[i].content)

    if (factsEqual && summariesEqual) {
      return { repaired: false, factDiff: 0, summaryDiff: 0 }
    }

    const factDiff = Math.abs(legacyFacts.length - projectedFacts.length) || legacyFacts.filter((f, i) => f.content !== projectedFacts[i]?.content).length
    const summaryDiff = Math.abs(legacySummaries.length - projectedSummaries.length) || legacySummaries.filter((a, i) => a.content !== projectedSummaries[i]?.content).length

    this.legacyFacts.replaceAll(projectedFacts)
    this.legacyKnowledge.replaceAll(projectedSummaries)
    this.legacyFacts.commit()
    this.legacyKnowledge.commit()

    return { repaired: true, factDiff, summaryDiff }
  }

  applyPropagation(propagation: {
    staleSummaryStableIds: string[]
    supersededFactStableIds: string[]
    reopenedGapStableIds: string[]
  }): void {
    for (const summaryId of propagation.staleSummaryStableIds) {
      this.legacyKnowledge.markStale(summaryId, propagation.supersededFactStableIds)
    }
    this.legacyKnowledge.commit()

    for (const factId of propagation.supersededFactStableIds) {
      this.legacyFacts.updateWhere((f) => f.id === factId, { content: '[deleted from source document]' })
    }
    this.legacyFacts.commit()
  }
}
