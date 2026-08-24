/**
 * Fact-node service (#682) — the fact group of the former MemoryService.
 */
import { ok, err, type Result } from '../common/result'
import { isNodeSuperseded, isNodeStale, sanitizeFactFields } from './memory.types.js'
import type { PropagationResult } from './curation/curation.engine'
import {
  MemoryNodeService,
  hashContent,
  newStableId,
  newNodeId,
  type MemoryCollaborators,
} from './node-base.js'
import type {
  AddFactInput,
  EditFactInput,
  FactNode,
  ArticleNode,
  MemoryCreatedBy,
} from './memory.types'

export class FactService extends MemoryNodeService {
  constructor(c: MemoryCollaborators) {
    super(c)
  }

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
      ownerId: this.c.ownerId,
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

    this.c.graph.addNode(fact)

    // Dual-write to legacy FactsStore (provisional — see commitGraphLast)
    // §4.3 (#188): carry confidence + provenance so retrieval can cite evidence.
    const legacyFacts = this.c.legacyFacts
    const legacy = legacyFacts.add({
      category: fact.category,
      importance: fact.importance ?? 3,
      content: fact.content,
      sourceType: (fact.sourceType === 'document' ? 'research' : fact.sourceType) as any,
      patientHash: fact.patientHash,
      studyId: fact.studyId,
      ttl: undefined,
      confidence: fact.confidence,
      provenance: fact.provenance
        ? {
            sourceKind: fact.provenance.sourceKind,
            sourceRef: fact.provenance.sourceRef,
            evidenceQuote: fact.provenance.evidenceQuote,
          }
        : undefined,
    })
    legacy.id = stableId
    legacyFacts.commit()

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
    const current = this.c.graph.getLatestByStableId(stableId) as FactNode | undefined
    if (!current || isNodeSuperseded(current)) return false

    const legacyBefore = this.snapshotLegacy()

    this.c.graph.markStatus(current.id, 'superseded')

    this.c.legacyFacts.remove(stableId)
    this.c.legacyFacts.commit()

    this.commitGraphLast(legacyBefore)

    this.appendEvent('memory_fact_superseded', `Superseded fact ${stableId} (${reason})`, {
      factId: stableId,
      supersededBy: by,
      reason,
    })
    return true
  }

  editFact(stableId: string, input: EditFactInput, editedBy: MemoryCreatedBy = 'user'): Result<FactNode> {
    const current = this.c.graph.getLatestByStableId(stableId) as FactNode | undefined
    if (!current || isNodeSuperseded(current)) return err('fact not found or superseded')

    const now = Date.now()
    const newVersion = current.version + 1
    const nextNodeId = newNodeId(stableId, newVersion)

    // Snapshot legacy before any provisional write so a graph-commit failure
    // can be compensated with a rollback (dual-store atomicity, #192).
    const legacyBefore = this.snapshotLegacy()

    // Supersede current version
    this.c.graph.markStatus(current.id, 'superseded')

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

    this.c.graph.addNode(edited)
    this.c.graph.addRelation({
      id: newStableId('rel'),
      sourceId: nextNodeId,
      targetId: current.id,
      relation: 'supersedes',
      createdAt: now,
    })

    // Update legacy store in place
    this.c.legacyFacts.updateWhere(
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
    this.c.legacyFacts.commit()

    // Propagate FIRST, then commit ONCE — curation's stale/superseded
    // changes must land on disk or they resurrect after a restart.
    const propagation = this.c.curation.propagateFactChange(stableId)
    this.applyPropagationToLegacy(propagation)
    this.commitGraphLast(legacyBefore)

    this.appendEvent('memory_fact_edited', `Edited fact ${stableId}`, {
      factId: stableId,
      previousVersionId: current.id,
      newVersionId: newNodeId,
      propagation,
    })

    return ok(edited)
  }

  deleteFact(stableId: string, deletedBy: MemoryCreatedBy = 'user'): Result<{ propagation?: PropagationResult }> {
    const current = this.c.graph.getLatestByStableId(stableId) as FactNode | undefined
    if (!current || isNodeSuperseded(current)) return err('fact not found or superseded')

    // Snapshot legacy before any provisional write (dual-store atomicity, #192).
    const legacyBefore = this.snapshotLegacy()

    this.c.graph.markStatus(current.id, 'superseded')

    const propagation = this.c.curation.propagateFactChange(stableId)
    this.applyPropagationToLegacy(propagation)

    // Remove the fact from the legacy projection so list counts drop.
    // The graph node remains superseded for audit/versioning.
    this.c.legacyFacts.remove(stableId)
    this.c.legacyFacts.commit()

    this.commitGraphLast(legacyBefore)

    // #439: keep derived indexes (embedding vectors) in sync with the graph.
    this.c.onNodeRemoved?.(stableId, 'fact')

    this.appendEvent('memory_fact_deleted', `Deleted fact ${stableId}`, {
      factId: stableId,
      deletedBy,
      propagation,
    })
    return ok({ propagation })
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
    const affected = this.c.graph.getCurrentNodesByType('fact').filter(
      (n): n is FactNode => n.type === 'fact' && n.patientHash === patientHash,
    )

    const staleIds = new Set<string>()
    const supersededIds = new Set<string>()

    for (const fact of affected) {
      const result = this.deleteFact(fact.stableId, 'system')
      if (!result.ok) continue
      const { propagation } = result.value
      if (propagation) {
        for (const articleId of propagation.staleArticleStableIds) {
          const article = this.c.graph.getLatestByStableId(articleId) as ArticleNode | undefined
          if (!article || isNodeSuperseded(article)) {
            supersededIds.add(articleId)
          } else if (isNodeStale(article)) {
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

}
