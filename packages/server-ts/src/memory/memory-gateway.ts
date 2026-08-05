/**
 * MemoryGraphGateway — thin facade over the memory subsystem (§5.1 #189).
 *
 * Reads (readContext) assemble the per-scope context bundle; writes go
 * exclusively through propose() → pending review → applyApproved()/
 * rejectProposal(). Implementation lives in the services under
 * embedding/, proposal/, context/, summary/ — external contracts unchanged.
 */
import type { MemoryService } from './memory.service.js'
import type { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../evolution/stores'
import { EmbeddingService } from './embedding/embedding.service.js'
import { ProposalService } from './proposal/proposal.service.js'
import { ContextAssembler } from './context/context-assembler.js'
import { SessionSummarizer } from './summary/session-summarizer.js'
import type { MemoryScope, ProposalInput, MemoryProposalRow, ContextBundle, MemoryNodeLike } from './contracts.js'

export type { MemoryScope, ProposalInput, MemoryProposalRow, ContextBundle }
export type { ProposalKind } from './contracts.js'

export class MemoryGraphGateway {
  private embedding: EmbeddingService
  private proposals: ProposalService
  private context: ContextAssembler
  private summarizer: SessionSummarizer

  constructor(
    private userId: string,
    private memory: MemoryService,
    private facts: FactsStore,
    private episodes: EpisodesStore,
    private skills: SkillsStore,
    private knowledge: KnowledgeStore,
    private embedFn?: (texts: string[]) => Promise<number[][]>,
  ) {
    this.embedding = new EmbeddingService(userId, memory, embedFn)
    this.proposals = new ProposalService(userId, memory, this.embedding)
    this.context = new ContextAssembler(memory, facts, episodes, skills, knowledge)
    this.summarizer = new SessionSummarizer(userId, episodes)
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

  /** Delegate for tests/tools that inject vectors into the per-user index. */
  embeddingIndex() {
    return this.embedding.embeddingIndex()
  }

  // ── Context assembly ─────────────────────────────────────────

  readContext(scope: MemoryScope): ContextBundle {
    return this.context.readContext(scope)
  }

  // ── Session summary ──────────────────────────────────────────

  summarize(input: {
    conversation: string
    sessionId: string
    patientHash?: string
    sinceIdx?: number
  }): Promise<{ summary: string; proposals: number }> {
    return this.summarizer.summarize(input)
  }
}

// §5.1 (#189): registries moved to registry.ts — re-exported for callers.
export {
  registerContextResolver,
  registerProposalApplier,
  getProposalApplier,
  defaultProposalApplier,
  type ContextResolver,
  type ProposalApplier,
} from './registry.js'
