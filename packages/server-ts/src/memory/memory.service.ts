import { createHash, randomUUID } from 'crypto'
import type { EventLog } from '../core/event-log'
import type { FactsStore, KnowledgeStore } from '../evolution/stores'
import type { Fact, KnowledgeArticle } from '../evolution/stores'
import { MemoryGraph } from './memory.graph'
import { CurationEngine, type PropagationResult } from './curation/curation.engine'
import type {
  AddFactInput,
  AddArticleInput,
  AddDocumentInput,
  AddGapInput,
  EditFactInput,
  EditArticleInput,
  FactNode,
  ArticleNode,
  DocumentNode,
  GapNode,
  MemoryNode,
  MemoryRelation,
  MemoryCreatedBy,
  CurationPolicy,
} from './memory.types'
import { DEFAULT_CURATION_POLICY, sanitizeFactFields } from './memory.types'

export interface MemoryServiceOptions {
  eventLog: EventLog
  baseDir: string
  legacyFacts: FactsStore
  legacyKnowledge: KnowledgeStore
  ownerId: string
  policy?: CurationPolicy
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function newStableId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function newNodeId(stableId: string, version: number): string {
  return `${stableId}@v${version}`
}

export class MemoryService {
  public eventLog: EventLog
  private legacyFacts: FactsStore
  private legacyKnowledge: KnowledgeStore
  private ownerId: string
  private policy: CurationPolicy
  public graph: MemoryGraph
  public curation: CurationEngine

  constructor(opts: MemoryServiceOptions) {
    this.eventLog = opts.eventLog
    this.legacyFacts = opts.legacyFacts
    this.legacyKnowledge = opts.legacyKnowledge
    this.ownerId = opts.ownerId
    this.policy = opts.policy || DEFAULT_CURATION_POLICY
    this.graph = new MemoryGraph(opts.baseDir)
    this.curation = new CurationEngine(this.graph, this.policy)
  }

  // ── Fact API ─────────────────────────────────────────────────

  addFact(input: AddFactInput, createdBy: MemoryCreatedBy = 'system'): FactNode {
    const now = Date.now()
    const stableId = newStableId('fact')
    const version = 1
    const nodeId = newNodeId(stableId, version)
    // §4.2 (#187): whitelist categories/source types, bound content length,
    // auto-mark low-confidence facts as uncertain.
    const clean = sanitizeFactFields({
      content: input.content,
      category: input.category,
      sourceType: input.sourceType,
      confidence: input.confidence,
      uncertain: input.uncertain,
    })
    const fact: FactNode = {
      id: nodeId,
      stableId,
      type: 'fact',
      ownerId: this.ownerId,
      status: 'current',
      content: clean.content,
      contentHash: hashContent(clean.content),
      version,
      category: clean.category,
      importance: input.importance ?? 3,
      sourceType: clean.sourceType,
      patientHash: input.patientHash,
      studyId: input.studyId,
      confidence: input.confidence ?? 0.8,
      uncertain: clean.uncertain,
      count: 1,
      createdAt: now,
      updatedAt: now,
      createdBy,
      provenance: {
        sourceKind: input.provenance?.sourceKind || (createdBy === 'user' ? 'user' : 'system'),
        ...input.provenance,
      },
      meta: {},
    }

    const legacyBefore = this.snapshotLegacy()

    this.graph.addNode(fact)

    // Dual-write to legacy FactsStore (provisional — see commitGraphLast)
    const legacy = this.legacyFacts.add({
      category: fact.category,
      importance: fact.importance ?? 3,
      content: fact.content,
      sourceType: (fact.sourceType === 'document' ? 'research' : fact.sourceType) as any,
      patientHash: fact.patientHash,
      studyId: fact.studyId,
      ttl: undefined,
    })
    legacy.id = stableId
    this.legacyFacts.commit()

    this.commitGraphLast(legacyBefore)

    this.appendEvent('memory_fact_added', `Added fact ${stableId}`, { factId: stableId, nodeId })
    return fact
  }

  /**
   * Supersede a current fact without replacing it — used when an approved
   * conflicting proposal (§5.7) wins over the old memory. The old node stays
   * in the graph (superseded status + audit trail), legacy projection drops
   * it so lists/counts reflect only active memories.
   */
  supersedeFact(stableId: string, reason: string, by: MemoryCreatedBy = 'system'): boolean {
    const current = this.graph.getLatestByStableId(stableId) as FactNode | undefined
    if (!current || current.status === 'superseded') return false

    const legacyBefore = this.snapshotLegacy()

    this.graph.markStatus(current.id, 'superseded')

    this.legacyFacts.remove(stableId)
    this.legacyFacts.commit()

    this.commitGraphLast(legacyBefore)

    this.appendEvent('memory_fact_superseded', `Superseded fact ${stableId} (${reason})`, {
      factId: stableId,
      supersededBy: by,
      reason,
    })
    return true
  }

  editFact(stableId: string, input: EditFactInput, editedBy: MemoryCreatedBy = 'user'): FactNode | null {
    const current = this.graph.getLatestByStableId(stableId) as FactNode | undefined
    if (!current || current.status === 'superseded') return null

    const now = Date.now()
    const newVersion = current.version + 1
    const nextNodeId = newNodeId(stableId, newVersion)

    // Snapshot legacy before any provisional write so a graph-commit failure
    // can be compensated with a rollback (dual-store atomicity, #192).
    const legacyBefore = this.snapshotLegacy()

    // Supersede current version
    this.graph.markStatus(current.id, 'superseded')

    const edited: FactNode = {
      ...current,
      id: nextNodeId,
      version: newVersion,
      previousVersionId: current.id,
      content: input.content ?? current.content,
      contentHash: hashContent(input.content ?? current.content),
      category: input.category ?? current.category,
      importance: input.importance ?? current.importance,
      sourceType: input.sourceType ?? current.sourceType,
      patientHash: input.patientHash !== undefined ? input.patientHash : current.patientHash,
      studyId: input.studyId !== undefined ? input.studyId : current.studyId,
      status: 'current',
      updatedAt: now,
      createdBy: editedBy,
    }

    this.graph.addNode(edited)
    this.graph.addRelation({
      id: newStableId('rel'),
      sourceId: nextNodeId,
      targetId: current.id,
      relation: 'supersedes',
      createdAt: now,
    })

    // Update legacy store in place
    this.legacyFacts.updateWhere(
      f => f.id === stableId,
      {
        content: edited.content,
        category: edited.category,
        importance: edited.importance,
        sourceType: (edited.sourceType === 'document' ? 'research' : edited.sourceType) as any,
        patientHash: edited.patientHash,
        studyId: edited.studyId,
      },
    )
    this.legacyFacts.commit()

    // Propagate FIRST, then commit ONCE — curation's stale/superseded
    // changes must land on disk or they resurrect after a restart.
    const propagation = this.curation.propagateFactChange(stableId)
    this.applyPropagationToLegacy(propagation)
    this.commitGraphLast(legacyBefore)

    this.appendEvent('memory_fact_edited', `Edited fact ${stableId}`, {
      factId: stableId,
      previousVersionId: current.id,
      newVersionId: newNodeId,
      propagation,
    })

    return edited
  }

  deleteFact(stableId: string, deletedBy: MemoryCreatedBy = 'user'): { ok: boolean; propagation?: PropagationResult } {
    const current = this.graph.getLatestByStableId(stableId) as FactNode | undefined
    if (!current || current.status === 'superseded') return { ok: false }

    // Snapshot legacy before any provisional write (dual-store atomicity, #192).
    const legacyBefore = this.snapshotLegacy()

    this.graph.markStatus(current.id, 'superseded')

    const propagation = this.curation.propagateFactChange(stableId)
    this.applyPropagationToLegacy(propagation)

    // Remove the fact from the legacy projection so list counts drop.
    // The graph node remains superseded for audit/versioning.
    this.legacyFacts.remove(stableId)
    this.legacyFacts.commit()

    this.commitGraphLast(legacyBefore)

    this.appendEvent('memory_fact_deleted', `Deleted fact ${stableId}`, {
      factId: stableId,
      deletedBy,
      propagation,
    })
    return { ok: true, propagation }
  }

  /**
   * Delete all facts tied to a patient when the patient is deleted.
   * Dependent knowledge articles are marked stale (or superseded if they
   * no longer have any current source facts).
   */
  deletePatientReferences(patientHash: string): {
    deletedFacts: number
    staleArticles: number
    supersededArticles: number
  } {
    const affected = this.graph.getCurrentNodesByType('fact').filter(
      (n): n is FactNode => n.type === 'fact' && n.patientHash === patientHash,
    )

    const staleIds = new Set<string>()
    const supersededIds = new Set<string>()

    for (const fact of affected) {
      const { ok, propagation } = this.deleteFact(fact.stableId, 'system')
      if (!ok) continue
      if (propagation) {
        for (const articleId of propagation.staleArticleStableIds) {
          const article = this.graph.getLatestByStableId(articleId) as ArticleNode | undefined
          if (!article || article.status === 'superseded') {
            supersededIds.add(articleId)
          } else if (article.status === 'stale') {
            staleIds.add(articleId)
          }
        }
      }
    }

    this.appendEvent('memory_patient_deleted', `Deleted patient references for ${patientHash}`, {
      patientHash,
      deletedFacts: affected.length,
      staleArticles: Array.from(staleIds),
      supersededArticles: Array.from(supersededIds),
    })

    return {
      deletedFacts: affected.length,
      staleArticles: staleIds.size,
      supersededArticles: supersededIds.size,
    }
  }

  // ── Article API ──────────────────────────────────────────────

  addArticle(input: AddArticleInput, createdBy: MemoryCreatedBy = 'system'): ArticleNode {
    const now = Date.now()
    const stableId = newStableId('article')
    const version = 1
    const nodeId = newNodeId(stableId, version)

    const sourceFacts: ArticleNode['sourceFacts'] = []
    const candidateNodeIds = [
      ...(input.sourceFactNodeIds || []),
      ...(input.sourceFactStableIds || [])
        .map(sid => {
          const latest = this.graph.getLatestByStableId(sid) as FactNode | undefined
          return latest?.id
        })
        .filter((id): id is string => !!id),
    ]
    for (const factNodeId of candidateNodeIds) {
      const fact = this.graph.getNode(factNodeId) as FactNode | undefined
      if (fact && fact.status !== 'superseded') {
        sourceFacts.push({
          nodeId: fact.id,
          stableId: fact.stableId,
          version: fact.version,
          snapshot: fact.content,
        })
        this.graph.addRelation({
          id: newStableId('rel'),
          sourceId: nodeId,
          targetId: fact.id,
          relation: 'depends_on',
          createdAt: now,
        })
      }
    }

    const article: ArticleNode = {
      id: nodeId,
      stableId,
      type: 'article',
      ownerId: this.ownerId,
      status: 'current',
      content: input.content,
      contentHash: hashContent(input.content),
      version,
      title: input.title,
      importance: 3,
      sourceFacts,
      sourceDocuments: input.sourceDocuments,
      createdAt: now,
      updatedAt: now,
      createdBy,
      provenance: {
        sourceKind: input.provenance?.sourceKind || (createdBy === 'user' ? 'user' : 'system'),
        ...input.provenance,
      },
      meta: {},
    }

    const legacyBefore = this.snapshotLegacy()

    this.graph.addNode(article)

    const legacy = this.legacyKnowledge.add({
      title: article.title,
      content: article.content,
      sources: sourceFacts.map(s => s.stableId),
    })
    legacy.id = stableId
    this.legacyKnowledge.commit()

    this.commitGraphLast(legacyBefore)

    this.appendEvent('memory_article_added', `Added article ${stableId}`, { articleId: stableId, nodeId })
    return article
  }

  editArticle(stableId: string, input: EditArticleInput, editedBy: MemoryCreatedBy = 'user'): ArticleNode | null {
    const current = this.graph.getLatestByStableId(stableId) as ArticleNode | undefined
    if (!current || current.status === 'superseded') return null

    const now = Date.now()
    const newVersion = current.version + 1
    const nextNodeId = newNodeId(stableId, newVersion)

    const legacyBefore = this.snapshotLegacy()

    this.graph.markStatus(current.id, 'superseded')

    const edited: ArticleNode = {
      ...current,
      id: nextNodeId,
      version: newVersion,
      previousVersionId: current.id,
      title: input.title ?? current.title,
      content: input.content ?? current.content,
      contentHash: hashContent(input.content ?? current.content),
      status: 'current',
      staleBecause: undefined,
      updatedAt: now,
      createdBy: editedBy,
    }

    this.graph.addNode(edited)
    // Re-wire depends_on relations to the new version
    for (const rel of this.graph.getRelationsFrom(current.id).filter(r => r.relation === 'depends_on')) {
      this.graph.addRelation({
        id: newStableId('rel'),
        sourceId: nextNodeId,
        targetId: rel.targetId,
        relation: 'depends_on',
        createdAt: now,
      })
    }
    this.graph.addRelation({
      id: newStableId('rel'),
      sourceId: nextNodeId,
      targetId: current.id,
      relation: 'supersedes',
      createdAt: now,
    })

    this.legacyKnowledge.update(stableId, {
      title: edited.title,
      content: edited.content,
      sources: edited.sourceFacts.map(s => s.stableId),
    })
    this.legacyKnowledge.commit()

    this.commitGraphLast(legacyBefore)

    this.appendEvent('memory_article_edited', `Edited article ${stableId}`, {
      articleId: stableId,
      previousVersionId: current.id,
      newVersionId: newNodeId,
    })

    return edited
  }

  deleteArticle(stableId: string, deletedBy: MemoryCreatedBy = 'user'): boolean {
    const current = this.graph.getLatestByStableId(stableId) as ArticleNode | undefined
    if (!current || current.status === 'superseded') return false

    const legacyBefore = this.snapshotLegacy()

    this.graph.markStatus(current.id, 'superseded')

    this.legacyKnowledge.remove(stableId)
    this.legacyKnowledge.commit()

    this.commitGraphLast(legacyBefore)

    this.appendEvent('memory_article_deleted', `Deleted article ${stableId}`, {
      articleId: stableId,
      deletedBy,
    })
    return true
  }

  regenerateArticle(stableId: string): ArticleNode | null {
    const current = this.graph.getLatestByStableId(stableId) as ArticleNode | undefined
    if (!current) return null
    const sourceFactNodeIds = current.sourceFacts.map(s => s.nodeId)
    const input: AddArticleInput = {
      title: current.title,
      content: current.content,
      sourceFactNodeIds,
      sourceDocuments: current.sourceDocuments,
    }
    // Mark old version superseded and create fresh version
    this.graph.markStatus(current.id, 'superseded')
    return this.addArticle(input, current.createdBy)
  }

  // ── Document API ─────────────────────────────────────────────

  addDocument(input: AddDocumentInput, createdBy: MemoryCreatedBy = 'system'): DocumentNode {
    const now = Date.now()
    const stableId = input.fileId || newStableId('doc')
    const version = 1
    const nodeId = newNodeId(stableId, version)

    const doc: DocumentNode = {
      id: nodeId,
      stableId,
      type: 'document',
      ownerId: this.ownerId,
      status: 'current',
      content: `${input.name} (${input.mimeType})`,
      contentHash: hashContent(input.sha256),
      version,
      fileId: input.fileId,
      sha256: input.sha256,
      name: input.name,
      mimeType: input.mimeType,
      patientHash: input.patientHash,
      createdAt: now,
      updatedAt: now,
      createdBy,
      provenance: {
        sourceKind: input.provenance?.sourceKind || 'system',
        ...input.provenance,
      },
      meta: {},
    }

    this.graph.addNode(doc)
    this.graph.commit()

    this.appendEvent('memory_document_uploaded', `Uploaded document ${stableId}`, { documentId: stableId, nodeId })
    return doc
  }

  deleteDocument(stableId: string, deletedBy: MemoryCreatedBy = 'user'): boolean {
    const current = this.graph.getLatestByStableId(stableId) as DocumentNode | undefined
    if (!current || current.status === 'superseded') return false

    // Snapshot legacy before any provisional write (dual-store atomicity, #192).
    const legacyBefore = this.snapshotLegacy()

    this.graph.markStatus(current.id, 'superseded')

    const propagation = this.curation.propagateDocumentDelete(stableId)
    this.applyPropagationToLegacy(propagation)

    this.commitGraphLast(legacyBefore)

    this.appendEvent('memory_document_deleted', `Deleted document ${stableId}`, {
      documentId: stableId,
      deletedBy,
      propagation,
    })
    return true
  }

  // ── Gap API ──────────────────────────────────────────────────

  addGap(input: AddGapInput, createdBy: MemoryCreatedBy = 'system'): GapNode {
    const now = Date.now()
    const stableId = newStableId('gap')
    const version = 1
    const nodeId = newNodeId(stableId, version)

    const gap: GapNode = {
      id: nodeId,
      stableId,
      type: 'gap',
      ownerId: this.ownerId,
      status: 'current',
      content: input.query,
      contentHash: hashContent(input.query),
      version,
      query: input.query,
      context: input.context,
      source: input.source,
      sourceId: input.sourceId,
      createdAt: now,
      updatedAt: now,
      createdBy,
      provenance: {
        sourceKind: input.provenance?.sourceKind || (createdBy === 'user' ? 'user' : 'system'),
        ...input.provenance,
      },
      meta: {},
    }

    this.graph.addNode(gap)
    this.graph.commit()

    this.appendEvent('memory_gap_detected', `Detected gap ${stableId}`, { gapId: stableId, nodeId })
    return gap
  }

  answerGap(gapStableId: string, answerNode: MemoryNode, answeredBy: MemoryCreatedBy = 'user'): GapNode | null {
    const gap = this.graph.getLatestByStableId(gapStableId) as GapNode | undefined
    if (!gap || gap.status === 'superseded') return null

    this.graph.updateNode(gap.id, {
      status: 'current',
      answerNodeId: answerNode.stableId,
    } as Partial<GapNode>)
    this.graph.addRelation({
      id: newStableId('rel'),
      sourceId: gap.id,
      targetId: answerNode.id,
      relation: 'answers',
      createdAt: Date.now(),
    })
    this.graph.commit()

    this.appendEvent('memory_gap_answered', `Answered gap ${gapStableId}`, {
      gapId: gapStableId,
      answerNodeId: answerNode.stableId,
    })
    return this.graph.getNode(gap.id) as GapNode
  }

  // ── Helpers ──────────────────────────────────────────────────

  /** Roll back all stores to their last committed disk state (#192). */
  private reloadAll() {
    this.graph.reload()
    this.legacyFacts.reload()
    this.legacyKnowledge.reload()
  }

  /** Deep-copy of the legacy stores, taken before provisional writes. */
  private snapshotLegacy() {
    return {
      facts: JSON.parse(JSON.stringify(this.legacyFacts.all())) as Fact[],
      knowledge: JSON.parse(JSON.stringify(this.legacyKnowledge.all())) as KnowledgeArticle[],
    }
  }

  /** Compensating write: restore the pre-mutation legacy state, #192. */
  private rollbackLegacy(snapshot: ReturnType<MemoryService['snapshotLegacy']>) {
    this.legacyFacts.replaceAll(snapshot.facts)
    this.legacyKnowledge.replaceAll(snapshot.knowledge)
    this.legacyFacts.commit()
    this.legacyKnowledge.commit()
    this.graph.reload()
  }

  /**
   * Dual-store atomicity (#192): the graph is the last store to commit.
   * Legacy commits are provisional — on graph-commit failure they are
   * compensated with a rollback to the snapshot, so the two stores can
   * never diverge on disk.
   */
  private commitGraphLast(legacyBefore: ReturnType<MemoryService['snapshotLegacy']>) {
    try {
      this.graph.commit()
    } catch (e) {
      this.rollbackLegacy(legacyBefore)
      throw e
    }
  }

  /**
   * Consistency reconciliation (#192): treat the graph as the source of
   * truth and rebuild the legacy projection from it. Idempotent — no-ops
   * when the stores already agree. Safe to call at startup or on demand.
   * Returns whether a divergence was found and repaired.
   */
  reconcileLegacy(): { repaired: boolean; factDiff: number; articleDiff: number } {
    const currentFacts = this.graph.getCurrentNodesByType('fact') as FactNode[]
    const currentArticles = this.graph.getCurrentNodesByType('article') as ArticleNode[]

    const projectedFacts = currentFacts.map(f => ({
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

    const projectedArticles = currentArticles.map(a => ({
      id: a.stableId,
      title: a.title,
      content: a.content,
      sources: a.sourceFacts.map(s => s.stableId),
      version: a.version,
      status: 'current' as const,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }))

    const legacyFacts = this.legacyFacts.all()
    const legacyArticles = this.legacyKnowledge.all()

    const factsEqual = legacyFacts.length === projectedFacts.length &&
      legacyFacts.every((f, i) => f.id === projectedFacts[i].id && f.content === projectedFacts[i].content && f.category === projectedFacts[i].category)
    const articlesEqual = legacyArticles.length === projectedArticles.length &&
      legacyArticles.every((a, i) => a.id === projectedArticles[i].id && a.title === projectedArticles[i].title && a.content === projectedArticles[i].content)

    if (factsEqual && articlesEqual) {
      return { repaired: false, factDiff: 0, articleDiff: 0 }
    }

    const factDiff = Math.abs(legacyFacts.length - projectedFacts.length) || legacyFacts.filter((f, i) => f.content !== projectedFacts[i]?.content).length
    const articleDiff = Math.abs(legacyArticles.length - projectedArticles.length) || legacyArticles.filter((a, i) => a.content !== projectedArticles[i]?.content).length

    this.legacyFacts.replaceAll(projectedFacts)
    this.legacyKnowledge.replaceAll(projectedArticles)
    this.legacyFacts.commit()
    this.legacyKnowledge.commit()

    return { repaired: true, factDiff, articleDiff }
  }

  private applyPropagationToLegacy(propagation: {
    staleArticleStableIds: string[]
    supersededFactStableIds: string[]
    reopenedGapStableIds: string[]
  }) {
    for (const articleId of propagation.staleArticleStableIds) {
      this.legacyKnowledge.markStale(articleId, propagation.supersededFactStableIds)
    }
    this.legacyKnowledge.commit()

    for (const factId of propagation.supersededFactStableIds) {
      this.legacyFacts.updateWhere(f => f.id === factId, { content: '[deleted from source document]' })
    }
    this.legacyFacts.commit()
  }

  private appendEvent(eventType: string, content: string, metadata: Record<string, unknown>) {
    this.eventLog.append({
      timestamp: Date.now() / 1000,
      eventType,
      content,
      metadata,
      agentId: this.ownerId,
      sessionId: 'memory',
    })
  }
}
