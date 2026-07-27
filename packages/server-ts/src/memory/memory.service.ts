import { createHash, randomUUID } from 'crypto'
import type { EventLog } from '../core/event-log'
import type { FactsStore, KnowledgeStore } from '../evolution/stores'
import { MemoryGraph } from './memory.graph'
import { CurationEngine } from './curation/curation.engine'
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
import { DEFAULT_CURATION_POLICY } from './memory.types'

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
  private eventLog: EventLog
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
    const fact: FactNode = {
      id: nodeId,
      stableId,
      type: 'fact',
      ownerId: this.ownerId,
      status: 'current',
      content: input.content,
      contentHash: hashContent(input.content),
      version,
      category: input.category || 'fact',
      importance: input.importance ?? 3,
      sourceType: input.sourceType || 'general',
      patientHash: input.patientHash,
      studyId: input.studyId,
      confidence: input.confidence ?? 0.8,
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

    this.graph.addNode(fact)
    this.graph.commit()

    // Dual-write to legacy FactsStore
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

    this.appendEvent('memory_fact_added', `Added fact ${stableId}`, { factId: stableId, nodeId })
    return fact
  }

  editFact(stableId: string, input: EditFactInput, editedBy: MemoryCreatedBy = 'user'): FactNode | null {
    const current = this.graph.getLatestByStableId(stableId) as FactNode | undefined
    if (!current || current.status === 'superseded') return null

    const now = Date.now()
    const newVersion = current.version + 1
    const nextNodeId = newNodeId(stableId, newVersion)

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

    this.graph.commit()

    const propagation = this.curation.propagateFactChange(stableId)
    this.applyPropagationToLegacy(propagation)

    this.appendEvent('memory_fact_edited', `Edited fact ${stableId}`, {
      factId: stableId,
      previousVersionId: current.id,
      newVersionId: newNodeId,
      propagation,
    })

    return edited
  }

  deleteFact(stableId: string, deletedBy: MemoryCreatedBy = 'user'): boolean {
    const current = this.graph.getLatestByStableId(stableId) as FactNode | undefined
    if (!current || current.status === 'superseded') return false

    this.graph.markStatus(current.id, 'superseded')
    this.graph.commit()

    const propagation = this.curation.propagateFactChange(stableId)
    this.applyPropagationToLegacy(propagation)

    if (this.policy.factDelete === 'hard') {
      // In hard mode we still keep the graph node superseded for audit; only legacy is removed
      this.legacyFacts.remove(stableId)
      this.legacyFacts.commit()
    } else {
      this.legacyFacts.updateWhere(f => f.id === stableId, { content: `[deleted] ${current.content}` })
      this.legacyFacts.commit()
    }

    this.appendEvent('memory_fact_deleted', `Deleted fact ${stableId}`, {
      factId: stableId,
      deletedBy,
      propagation,
    })
    return true
  }

  /**
   * Remove patient-specific references from all current facts when a patient is deleted.
   * The facts are kept as general knowledge; their patientHash is cleared.
   */
  clearPatientReferences(patientHash: string): number {
    const affected = this.graph.getCurrentNodesByType('fact').filter(
      (n): n is FactNode => n.type === 'fact' && n.patientHash === patientHash,
    )
    if (affected.length === 0) return 0

    const now = Date.now()
    const stableIds: string[] = []
    for (const fact of affected) {
      const updated: FactNode = {
        ...fact,
        patientHash: undefined,
        sourceType: 'general',
        updatedAt: now,
      }
      this.graph.updateNode(fact.id, updated)
      stableIds.push(fact.stableId)
    }
    this.graph.commit()

    for (const stableId of stableIds) {
      this.legacyFacts.updateWhere(
        f => f.id === stableId,
        { patientHash: undefined, sourceType: 'general' },
      )
    }
    this.legacyFacts.commit()

    this.appendEvent('memory_patient_refs_cleared', `Cleared patient refs for ${patientHash}`, {
      patientHash,
      factCount: affected.length,
      factIds: stableIds,
    })
    return affected.length
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

    this.graph.addNode(article)
    this.graph.commit()

    const legacy = this.legacyKnowledge.add({
      title: article.title,
      content: article.content,
      sources: sourceFacts.map(s => s.stableId),
    })
    legacy.id = stableId
    this.legacyKnowledge.commit()

    this.appendEvent('memory_article_added', `Added article ${stableId}`, { articleId: stableId, nodeId })
    return article
  }

  editArticle(stableId: string, input: EditArticleInput, editedBy: MemoryCreatedBy = 'user'): ArticleNode | null {
    const current = this.graph.getLatestByStableId(stableId) as ArticleNode | undefined
    if (!current || current.status === 'superseded') return null

    const now = Date.now()
    const newVersion = current.version + 1
    const nextNodeId = newNodeId(stableId, newVersion)

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
    this.graph.commit()

    this.legacyKnowledge.update(stableId, {
      title: edited.title,
      content: edited.content,
      sources: edited.sourceFacts.map(s => s.stableId),
    })
    this.legacyKnowledge.commit()

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

    this.graph.markStatus(current.id, 'superseded')
    this.graph.commit()

    this.legacyKnowledge.remove(stableId)
    this.legacyKnowledge.commit()

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

    this.graph.markStatus(current.id, 'superseded')
    this.graph.commit()

    const propagation = this.curation.propagateDocumentDelete(stableId)
    this.applyPropagationToLegacy(propagation)

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
