/**
 * Summary-node service (#682) — the summary group of the former MemoryService.
 */
import { ok, err, type Result } from '../common/result'
import { isNodeSuperseded } from './memory.types.js'
import { MemoryNodeService, hashContent, newStableId, newNodeId, type MemoryCollaborators } from './node-base.js'
import type { AddSummaryInput, EditSummaryInput, SummaryNode, FactNode, MemoryCreatedBy } from './memory.types'

export class SummaryService extends MemoryNodeService {
  constructor(c: MemoryCollaborators) {
    super(c)
  }

  addSummary(input: AddSummaryInput, createdBy: MemoryCreatedBy = 'system'): SummaryNode {
    const now = Date.now()
    const stableId = newStableId('summary')
    const version = 1
    const nodeId = newNodeId(stableId, version)

    const sourceFacts: SummaryNode['sourceFacts'] = []
    const candidateNodeIds = [
      ...(input.sourceFactNodeIds || []),
      ...(input.sourceFactStableIds || [])
        .map(sid => {
          const latest = this.c.graph.getLatestByStableId(sid) as FactNode | undefined
          return latest?.id
        })
        .filter((id): id is string => !!id),
    ]
    for (const factNodeId of candidateNodeIds) {
      const fact = this.c.graph.getNode(factNodeId) as FactNode | undefined
      if (fact && fact.status !== 'superseded') {
        sourceFacts.push({
          nodeId: fact.id,
          stableId: fact.stableId,
          version: fact.version,
          snapshot: fact.content,
        })
        this.c.graph.addRelation({
          id: newStableId('rel'),
          sourceId: nodeId,
          targetId: fact.id,
          relation: 'depends_on',
          createdAt: now,
        })
      }
    }

    const summary: SummaryNode = {
      id: nodeId,
      stableId,
      type: 'summary',
      ownerId: this.c.ownerId,
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

    this.c.graph.addNode(summary)

    const legacy = this.c.legacyKnowledge.add({
      title: summary.title,
      content: summary.content,
      sources: sourceFacts.map(s => s.stableId),
    })
    legacy.id = stableId
    this.c.legacyKnowledge.commit()

    this.commitGraphLast(legacyBefore)

    this.appendEvent('memory_summary_added', `Added summary ${stableId}`, { summaryId: stableId, nodeId })
    return summary
  }

  editSummary(stableId: string, input: EditSummaryInput, editedBy: MemoryCreatedBy = 'user'): Result<SummaryNode> {
    const current = this.c.graph.getLatestByStableId(stableId) as SummaryNode | undefined
    if (!current || isNodeSuperseded(current)) return err('summary not found or superseded')

    const now = Date.now()
    const newVersion = current.version + 1
    const nextNodeId = newNodeId(stableId, newVersion)

    const legacyBefore = this.snapshotLegacy()

    this.c.graph.markStatus(current.id, 'superseded')

    const edited: SummaryNode = {
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

    this.c.graph.addNode(edited)
    // Re-wire depends_on relations to the new version
    for (const rel of this.c.graph.getRelationsFrom(current.id).filter(r => r.relation === 'depends_on')) {
      this.c.graph.addRelation({
        id: newStableId('rel'),
        sourceId: nextNodeId,
        targetId: rel.targetId,
        relation: 'depends_on',
        createdAt: now,
      })
    }
    this.c.graph.addRelation({
      id: newStableId('rel'),
      sourceId: nextNodeId,
      targetId: current.id,
      relation: 'supersedes',
      createdAt: now,
    })

    this.c.legacyKnowledge.update(stableId, {
      title: edited.title,
      content: edited.content,
      sources: edited.sourceFacts.map(s => s.stableId),
    })
    this.c.legacyKnowledge.commit()

    this.commitGraphLast(legacyBefore)

    this.appendEvent('memory_article_edited', `Edited summary ${stableId}`, {
      summaryId: stableId,
      previousVersionId: current.id,
      newVersionId: newNodeId,
    })

    return ok(edited)
  }

  deleteSummary(stableId: string, deletedBy: MemoryCreatedBy = 'user'): Result<void> {
    const current = this.c.graph.getLatestByStableId(stableId) as SummaryNode | undefined
    if (!current || isNodeSuperseded(current)) return err('summary not found or superseded')

    const legacyBefore = this.snapshotLegacy()

    this.c.graph.markStatus(current.id, 'superseded')

    this.c.legacyKnowledge.remove(stableId)
    this.c.legacyKnowledge.commit()

    this.commitGraphLast(legacyBefore)

    // #439: keep derived indexes (embedding vectors) in sync with the graph.
    this.c.onNodeRemoved?.(stableId, 'summary')

    this.appendEvent('memory_article_deleted', `Deleted summary ${stableId}`, {
      summaryId: stableId,
      deletedBy,
    })
    return ok(undefined)
  }

  regenerateSummary(stableId: string): Result<SummaryNode> {
    const current = this.c.graph.getLatestByStableId(stableId) as SummaryNode | undefined
    if (!current) return err('summary not found')
    // #741: reference facts by stableId — addSummary resolves the LATEST
    // version, so curation edits between generations no longer leave the new
    // summary citing superseded node versions (or dropping them silently).
    const sourceFactStableIds = current.sourceFacts.map(s => s.stableId)
    const input: AddSummaryInput = {
      title: current.title,
      content: current.content,
      sourceFactStableIds,
      sourceDocuments: current.sourceDocuments,
    }
    // Mark old version superseded and create fresh version
    this.c.graph.markStatus(current.id, 'superseded')
    return ok(this.addSummary(input, current.createdBy))
  }
}
