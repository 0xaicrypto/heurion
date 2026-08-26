/**
 * Article-node service (#682) — the article group of the former MemoryService.
 */
import { ok, err, type Result } from '../common/result'
import { isNodeSuperseded } from './memory.types.js'
import { MemoryNodeService, hashContent, newStableId, newNodeId, type MemoryCollaborators } from './node-base.js'
import type { AddArticleInput, EditArticleInput, ArticleNode, FactNode, MemoryCreatedBy } from './memory.types'

export class ArticleService extends MemoryNodeService {
  constructor(c: MemoryCollaborators) {
    super(c)
  }

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

    const article: ArticleNode = {
      id: nodeId,
      stableId,
      type: 'article',
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

    this.c.graph.addNode(article)

    const legacy = this.c.legacyKnowledge.add({
      title: article.title,
      content: article.content,
      sources: sourceFacts.map(s => s.stableId),
    })
    legacy.id = stableId
    this.c.legacyKnowledge.commit()

    this.commitGraphLast(legacyBefore)

    this.appendEvent('memory_article_added', `Added article ${stableId}`, { articleId: stableId, nodeId })
    return article
  }

  editArticle(stableId: string, input: EditArticleInput, editedBy: MemoryCreatedBy = 'user'): Result<ArticleNode> {
    const current = this.c.graph.getLatestByStableId(stableId) as ArticleNode | undefined
    if (!current || isNodeSuperseded(current)) return err('article not found or superseded')

    const now = Date.now()
    const newVersion = current.version + 1
    const nextNodeId = newNodeId(stableId, newVersion)

    const legacyBefore = this.snapshotLegacy()

    this.c.graph.markStatus(current.id, 'superseded')

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

    this.appendEvent('memory_article_edited', `Edited article ${stableId}`, {
      articleId: stableId,
      previousVersionId: current.id,
      newVersionId: newNodeId,
    })

    return ok(edited)
  }

  deleteArticle(stableId: string, deletedBy: MemoryCreatedBy = 'user'): Result<void> {
    const current = this.c.graph.getLatestByStableId(stableId) as ArticleNode | undefined
    if (!current || isNodeSuperseded(current)) return err('article not found or superseded')

    const legacyBefore = this.snapshotLegacy()

    this.c.graph.markStatus(current.id, 'superseded')

    this.c.legacyKnowledge.remove(stableId)
    this.c.legacyKnowledge.commit()

    this.commitGraphLast(legacyBefore)

    // #439: keep derived indexes (embedding vectors) in sync with the graph.
    this.c.onNodeRemoved?.(stableId, 'article')

    this.appendEvent('memory_article_deleted', `Deleted article ${stableId}`, {
      articleId: stableId,
      deletedBy,
    })
    return ok(undefined)
  }

  regenerateArticle(stableId: string): Result<ArticleNode> {
    const current = this.c.graph.getLatestByStableId(stableId) as ArticleNode | undefined
    if (!current) return err('article not found')
    // #741: reference facts by stableId — addArticle resolves the LATEST
    // version, so curation edits between generations no longer leave the new
    // article citing superseded node versions (or dropping them silently).
    const sourceFactStableIds = current.sourceFacts.map(s => s.stableId)
    const input: AddArticleInput = {
      title: current.title,
      content: current.content,
      sourceFactStableIds,
      sourceDocuments: current.sourceDocuments,
    }
    // Mark old version superseded and create fresh version
    this.c.graph.markStatus(current.id, 'superseded')
    return ok(this.addArticle(input, current.createdBy))
  }
}
