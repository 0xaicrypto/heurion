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

  /**
   * #25 — hybrid retrieval: vector recall → graph traversal expansion →
   * rerank by connectivity → provenance. The returned hits carry a
   * `score` (vector similarity), `connections` (neighbor node summaries
   * with edge kinds) and `via` (the neighbor that linked them, when the
   * hit was discovered by expansion).
   */
  async retrieveGraphEnhanced(
    query: string,
    scope: MemoryScope,
    opts: { topK?: number; minScore?: number; expansionDepth?: number; expandLimit?: number } = {},
  ): Promise<Array<{
    stableId: string
    content: string
    type: string
    score: number
    connections: Array<{ stableId: string; type: string; content: string; edge: string }>
    via?: string
  }>> {
    const topK = opts.topK ?? 8
    const minScore = opts.minScore ?? 0.3
    const depth = opts.expansionDepth ?? 1
    const expandLimit = opts.expandLimit ?? 20

    const vectorHits = await this.retrieve(query, scope, { topK, minScore })
    const byStable = new Map<string, any>()
    for (const n of this.memory.graph.getAllNodes()) {
      const cur = byStable.get(n.stableId)
      if (!cur || n.version > cur.version) byStable.set(n.stableId, n)
    }

    const results = new Map<string, {
      stableId: string
      content: string
      type: string
      score: number
      connections: Array<{ stableId: string; type: string; content: string; edge: string }>
      via?: string
    }>()

    // 1. Vector hits with their graph neighbors (provenance).
    for (const h of vectorHits) {
      const node = byStable.get(h.stableId)
      const connections = node
        ? this.memory.graph.getNeighbors(h.stableId, depth)
            .slice(0, expandLimit)
            .map(({ node: nb, edge }) => ({
              stableId: nb.stableId,
              type: nb.type,
              content: String((nb as any).content || (nb as any).title || '').slice(0, 200),
              edge: edge.relation,
            }))
        : []
      results.set(h.stableId, {
        stableId: h.stableId,
        content: h.content,
        type: h.type,
        score: h.score,
        connections,
      })
    }

    // 2. Graph expansion: nodes reachable from vector hits also surface
    // (boosted by connectivity), tagged with `via` for provenance.
    const viaSeeds = vectorHits.map((h) => h.stableId)
    const expandBy = new Set<string>(viaSeeds)
    for (const seed of viaSeeds) {
      for (const { node: nb } of this.memory.graph.getNeighbors(seed, depth).slice(0, expandLimit)) {
        if (expandBy.has(nb.stableId)) continue
        if (nb.type !== 'fact' && nb.type !== 'article' && nb.type !== 'skill' && nb.type !== 'gap') continue
        expandBy.add(nb.stableId)
        const content = String((nb as any).content || (nb as any).title || '').slice(0, 300)
        const conns = this.memory.graph.getNeighbors(nb.stableId, 1)
          .slice(0, 8)
          .map(({ node: n2, edge }) => ({
            stableId: n2.stableId,
            type: n2.type,
            content: String((n2 as any).content || (n2 as any).title || '').slice(0, 150),
            edge: edge.relation,
          }))
        results.set(nb.stableId, {
          stableId: nb.stableId,
          content,
          type: nb.type,
          // Connectivity-weighted: graph-reached facts score between the
          // vector threshold and the lowest vector hit.
          score: Math.max(minScore * 0.9, (minScore * 0.9) + Math.min(conns.length, 5) * 0.02),
          connections: conns,
          via: seed,
        })
      }
    }

    // 3. Rerank: vector score first, connectivity as tie-break.
    return Array.from(results.values())
      .sort((a, b) => (b.score - a.score) || (b.connections.length - a.connections.length))
      .slice(0, Math.max(topK, topK * 2))
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
