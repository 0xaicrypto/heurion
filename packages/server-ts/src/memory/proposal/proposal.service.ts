import prisma from '../../common/prisma.js'
import type { MemoryService } from '../memory.service.js'
import { sanitizeFactFields } from '../memory.types'
import type { EmbeddingService } from '../embedding/embedding.service.js'
import type { MemoryScope, ProposalInput, MemoryProposalRow, MemoryNodeLike } from '../contracts.js'
import { serializeProposal } from '../contracts.js'
import { getProposalApplier } from '../registry.js'

/**
 * §5.1 (#189): proposal lifecycle — propose/listPending/apply/reject/mark.
 * The ONLY entry point for extracted/summarized memories: nothing writes
 * the graph directly (design: BRAIN2_MEMORY_LIFECYCLE §3, §5.2).
 */
export class ProposalService {
  constructor(
    private userId: string,
    private memory: MemoryService,
    private embedding: EmbeddingService,
  ) {}

  /**
   * Create a pending memory proposal with semantic dedup (>= 0.95 in the
   * same scope → auto-rejected) and same-scope conflict markers (§5.7).
   */
  async propose(input: ProposalInput): Promise<MemoryProposalRow> {
    // §4.2 (#187): whitelist + bound fact fields before they enter the queue.
    let content = input.content
    let category = input.category || null
    if (input.kind === 'fact') {
      const clean = sanitizeFactFields({ content, category: category || undefined, sourceType: undefined, confidence: undefined })
      content = clean.content
      category = clean.category
    } else {
      content = content.slice(0, 300)
    }

    // Semantic dedup against reviewed memories in the same scope.
    const contentVec = await this.embedding.embedOrNull(content)
    if (contentVec) {
      const similar = this.embedding.embeddingIndex().findMostSimilar(contentVec, {
        patientHash: input.patientHash,
        studyId: input.studyId,
      })
      if (similar && similar.score >= 0.95) {
        const now = new Date().toISOString()
        return {
          id: `dup_${now}`,
          userId: this.userId,
          scopeType: input.scopeType,
          patientHash: input.patientHash || null,
          studyId: input.studyId || null,
          kind: input.kind,
          content,
          importance: input.importance ?? 3,
          confidence: input.confidence ?? 'medium',
          reason: input.reason || null,
          sourceRange: input.sourceRange || null,
          category,
          conflictsWith: null,
          status: 'rejected',
          rejectedReason: `语义重复（与 ${similar.record.stableId} 相似度 ${similar.score.toFixed(2)}）`,
          createdAt: now,
          resolvedAt: now,
          resolvedBy: 'system',
        }
      }
    }

    const now = new Date().toISOString()
    // §5.7: conflict markers must point at same-scope confirmed facts.
    const conflictsWith = this.filterSameScopeConflicts(input)
    const row = await (prisma as any).memoryProposal.create({
      data: {
        userId: this.userId,
        scopeType: input.scopeType,
        patientHash: input.patientHash || null,
        studyId: input.studyId || null,
        kind: input.kind,
        content,
        importance: input.importance ?? 3,
        confidence: input.confidence ?? 'medium',
        reason: input.reason || null,
        sourceRange: input.sourceRange || null,
        category,
        conflictsWith: conflictsWith ? JSON.stringify(conflictsWith) : null,
        status: 'pending',
        createdAt: now,
      },
    })
    try {
      const { createApprovalRequest } = await import('../../modules/approvals/approval.service.js')
      await createApprovalRequest(this.userId, {
        targetType: 'MemoryProposal',
        targetId: row.id,
        payload: serializeProposal(row),
      })
    } catch (err) {
      console.log('[MEMORY] Approval request enqueue skipped:', (err as Error).message.slice(0, 120))
    }
    return serializeProposal(row)
  }

  async listPending(scope?: MemoryScope): Promise<MemoryProposalRow[]> {
    const where: any = { userId: this.userId, status: 'pending' }
    if (scope?.patientHash) {
      where.scopeType = 'patient'
      where.patientHash = scope.patientHash
    } else if (scope?.studyId) {
      where.scopeType = 'study'
      where.studyId = scope.studyId
    } else if (scope?.global) {
      where.scopeType = 'global'
    }
    const rows = await (prisma as any).memoryProposal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })
    return rows.map(serializeProposal)
  }

  /** §5.7 — keep only conflict markers that reference a confirmed fact in the SAME scope. */
  private filterSameScopeConflicts(input: ProposalInput): Array<{ stableId: string; content: string }> | null {
    if (!input.conflictsWith?.length || !this.memory) return null
    const kept = input.conflictsWith.filter((c) => {
      const node = this.memory.graph.getLatestByStableId(c.stableId) as any
      if (!node || node.status !== 'current') return false
      if (input.scopeType === 'patient') return node.patientHash === input.patientHash
      if (input.scopeType === 'study') return node.studyId === input.studyId
      return !node.patientHash && !node.studyId
    })
    return kept.length > 0 ? kept : null
  }

  async rejectProposal(proposalId: string, reason: string, actorId: string): Promise<boolean> {
    const now = new Date().toISOString()
    const updated = await (prisma as any).memoryProposal.updateMany({
      where: { id: proposalId, userId: this.userId, status: 'pending' },
      data: { status: 'rejected', rejectedReason: reason, resolvedAt: now, resolvedBy: actorId },
    })
    return updated.count > 0
  }

  async markApproved(proposalId: string, actorId: string): Promise<boolean> {
    const now = new Date().toISOString()
    const updated = await (prisma as any).memoryProposal.updateMany({
      where: { id: proposalId, userId: this.userId, status: 'pending' },
      data: { status: 'approved', resolvedAt: now, resolvedBy: actorId },
    })
    return updated.count > 0
  }

  /** Apply an approved proposal through the registered applier + index embeddings. */
  async applyApproved(proposal: MemoryProposalRow): Promise<MemoryNodeLike | null> {
    const applier = getProposalApplier()
    if (!applier) return null
    const node = applier(this.userId, proposal) as MemoryNodeLike | null
    if (node) {
      // Reviewed memories only enter RAG (§4.5).
      await this.embedding.indexApproved({
        nodeId: node.id,
        stableId: node.stableId,
        type: proposal.kind === 'article' ? 'article' : 'fact',
        content: proposal.content,
        patientHash: proposal.patientHash || (node as any).patientHash,
        studyId: proposal.studyId || (node as any).studyId,
      })
    }
    return node
  }
}
