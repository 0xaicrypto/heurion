/**
 * MemoryService — composition root over the per-node-type services (#682).
 *
 * The former god class (4 node-type CRUD groups + legacy dual-write) is
 * split into FactService / ArticleService / DocumentService / GapService;
 * this facade keeps the historical public API (addFact, addArticle, …,
 * graph, eventLog, curation) so callers are unaffected.
 */
import type { EventLog } from '../core/event-log'
import type { FactsStore, KnowledgeStore } from '../evolution/stores'
import type { Result } from '../common/result'
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
  MemoryCreatedBy,
} from './memory.types'
import { MemoryGraph } from './memory.graph'
import { CurationEngine, type PropagationResult } from './curation/curation.engine'
import { LegacyProjection } from './legacy-projection.js'
import { PropagationCoordinator } from './propagation-coordinator.js'
import { buildMemoryCollaborators, type MemoryCollaborators } from './node-base.js'
import { FactService } from './fact-service.js'
import { ArticleService } from './article-service.js'
import { DocumentService } from './document-service.js'
import { GapService } from './gap-service.js'

export interface MemoryServiceOptions {
  eventLog: EventLog
  baseDir: string
  legacyFacts: FactsStore
  legacyKnowledge: KnowledgeStore
  ownerId: string
  /** #439: invoked after a node is superseded/deleted so the caller can sync
   *  derived indexes (e.g. embedding vectors) with the graph commit. */
  onNodeRemoved?: (stableId: string, type: string) => void
}

export class MemoryService {
  public eventLog: EventLog
  public graph: MemoryGraph
  public curation: CurationEngine
  /** #304: internal collaborators — write order is testable in isolation. */
  public legacyProjection: LegacyProjection
  public propagation: PropagationCoordinator
  /** Legacy stores, re-exposed for dual-write verification (#192 tests). */
  public legacyFacts: FactsStore
  public legacyKnowledge: KnowledgeStore

  private readonly collaborators: MemoryCollaborators
  private readonly facts: FactService
  private readonly articles: ArticleService
  private readonly documents: DocumentService
  private readonly gaps: GapService

  constructor(opts: MemoryServiceOptions) {
    this.eventLog = opts.eventLog
    this.collaborators = buildMemoryCollaborators(opts)
    this.graph = this.collaborators.graph
    this.curation = this.collaborators.curation
    this.legacyProjection = this.collaborators.legacyProjection
    this.propagation = this.collaborators.propagation
    this.legacyFacts = this.collaborators.legacyFacts
    this.legacyKnowledge = this.collaborators.legacyKnowledge
    this.facts = new FactService(this.collaborators)
    this.articles = new ArticleService(this.collaborators)
    this.documents = new DocumentService(this.collaborators)
    this.gaps = new GapService(this.collaborators)
  }

  // ── Fact API ─────────────────────────────────────────────────

  addFact(input: AddFactInput, createdBy: MemoryCreatedBy = 'system'): FactNode {
    return this.facts.addFact(input, createdBy)
  }

  supersedeFact(stableId: string, reason: string, by: MemoryCreatedBy = 'system'): boolean {
    return this.facts.supersedeFact(stableId, reason, by)
  }

  editFact(stableId: string, input: EditFactInput, editedBy: MemoryCreatedBy = 'user'): Result<FactNode> {
    return this.facts.editFact(stableId, input, editedBy)
  }

  deleteFact(stableId: string, deletedBy: MemoryCreatedBy = 'user'): Result<{ propagation?: PropagationResult }> {
    return this.facts.deleteFact(stableId, deletedBy)
  }

  deletePatientReferences(patientHash: string): {
    deletedFacts: number
    staleArticles: number
    supersededArticles: number
  } {
    return this.facts.deletePatientReferences(patientHash)
  }

  // ── Article API ──────────────────────────────────────────────

  addArticle(input: AddArticleInput, createdBy: MemoryCreatedBy = 'system'): ArticleNode {
    return this.articles.addArticle(input, createdBy)
  }

  editArticle(stableId: string, input: EditArticleInput, editedBy: MemoryCreatedBy = 'user'): Result<ArticleNode> {
    return this.articles.editArticle(stableId, input, editedBy)
  }

  deleteArticle(stableId: string, deletedBy: MemoryCreatedBy = 'user'): Result<void> {
    return this.articles.deleteArticle(stableId, deletedBy)
  }

  regenerateArticle(stableId: string): Result<ArticleNode> {
    return this.articles.regenerateArticle(stableId)
  }

  // ── Document API ─────────────────────────────────────────────

  addDocument(input: AddDocumentInput, createdBy: MemoryCreatedBy = 'system'): DocumentNode {
    return this.documents.addDocument(input, createdBy)
  }

  deleteDocument(stableId: string, deletedBy: MemoryCreatedBy = 'user'): Result<void> {
    return this.documents.deleteDocument(stableId, deletedBy)
  }

  // ── Gap API ──────────────────────────────────────────────────

  addGap(input: AddGapInput, createdBy: MemoryCreatedBy = 'system'): GapNode {
    return this.gaps.addGap(input, createdBy)
  }

  answerGap(gapStableId: string, answerNode: MemoryNode, answeredBy: MemoryCreatedBy = 'user'): Result<GapNode> {
    return this.gaps.answerGap(gapStableId, answerNode, answeredBy)
  }

  // ── Helpers ──────────────────────────────────────────────────

  /**
   * Consistency reconciliation (#192): treat the graph as the source of
   * truth and rebuild the legacy projection from it. Idempotent — no-ops
   * when the stores already agree. Safe to call at startup or on demand.
   * Returns whether a divergence was found and repaired.
   */
  reconcileLegacy(): { repaired: boolean; factDiff: number; articleDiff: number } {
    return this.legacyProjection.reconcile()
  }
}
