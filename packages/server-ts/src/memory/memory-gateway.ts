/**
 * MemoryGraphGateway — thin facade over the memory subsystem (§5.1 #189).
 *
 * Writes go exclusively through propose() → pending review → applyApproved()/
 * rejectProposal(). Implementation lives in the services under embedding/,
 * proposal/, summary/ — external contracts unchanged.
 */
import type { MemoryService } from './memory.service.js'
import type { EpisodesStore } from '../evolution/stores'
import { EmbeddingService } from './embedding/embedding.service.js'
import { ProposalService } from './proposal/proposal.service.js'
import { SessionSummarizer } from './summary/session-summarizer.js'
import type { MemoryScope, ProposalInput, MemoryProposalRow, MemoryNodeLike } from './contracts.js'

export type { MemoryScope, ProposalInput, MemoryProposalRow }
export type { ProposalKind } from './contracts.js'

export class MemoryGraphGateway {
  private embedding: EmbeddingService
  private proposals: ProposalService
  private summarizer: SessionSummarizer | null = null

  constructor(
    userId: string,
    memory: MemoryService,
    /** #646: only episodes is still consumed (SessionSummarizer) — the
     *  facts/skills/knowledge stores fed the removed ContextAssembler. */
    episodes?: EpisodesStore,
    embedFn?: (texts: string[]) => Promise<number[][]>,
  ) {
    this.embedding = new EmbeddingService(userId, memory, embedFn)
    this.proposals = new ProposalService(userId, memory, this.embedding)
    this.summarizer = episodes ? new SessionSummarizer(userId, episodes) : null
  }

  // ── Proposal lifecycle ───────────────────────────────────────

  propose(input: ProposalInput): Promise<MemoryProposalRow> {
    return this.proposals.propose(input)
  }

  listPending(scope?: MemoryScope): Promise<MemoryProposalRow[]> {
    return this.proposals.listPending(scope)
  }

  applyApproved(proposal: MemoryProposalRow): Promise<MemoryNodeLike | null> {
    return this.proposals.applyApproved(proposal)
  }

  rejectProposal(proposalId: string, reason: string, actorId: string): Promise<boolean> {
    return this.proposals.rejectProposal(proposalId, reason, actorId)
  }

  markApproved(proposalId: string, actorId: string): Promise<boolean> {
    return this.proposals.markApproved(proposalId, actorId)
  }

  // ── Retrieval ────────────────────────────────────────────────

  /** Stubbable embed hook — tests override it (embedding-sync.test.ts). */
  embedOrNull = (text: string): Promise<number[] | null> => this.embedding.embedOrNull(text)

  retrieve(
    query: string,
    scope: MemoryScope,
    opts: { topK?: number; minScore?: number; includeCrossPatient?: boolean } = {},
  ): Promise<Array<{ stableId: string; content: string; type: string; score: number }>> {
    return this.embedOrNull(query).then(vec => vec ? this.embedding.retrieveWithVec(vec, scope, opts) : [])
  }

  /**
   * #25 — hybrid retrieval: vector recall → graph traversal expansion →
   * rerank by connectivity → provenance. The returned hits carry a
   * `score` (vector similarity), `connections` (neighbor node summaries
   * with edge kinds) and `via` (the neighbor that linked them, when the
   * hit was discovered by expansion).
   */
  /** Delegate for tests/tools that inject vectors into the per-user index. */
  embeddingIndex() {
    return this.embedding.embeddingIndex()
  }

  // ── Session summary ──────────────────────────────────────────

  summarize(input: {
    conversation: string
    sessionId: string
    patientHash?: string
    sinceIdx?: number
  }): Promise<{ summary: string; proposals: number }> {
    if (!this.summarizer) throw new Error('SessionSummarizer requires an EpisodesStore')
    return this.summarizer.summarize(input)
  }
}

// §5.1 (#189): registries moved to registry.ts — re-exported for callers.
export {
  registerContextResolver,
  registerProposalApplier,
  getProposalApplier,
  registerProposalCreatedHandler,
  getProposalCreatedHandler,
  defaultProposalApplier,
  type ContextResolver,
  type ProposalApplier,
  type ProposalCreatedHandler,
} from './registry.js'
