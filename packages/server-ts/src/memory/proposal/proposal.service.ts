import prisma from '../../common/prisma.js'
import { makeLogger } from '../../common/logger.js'
import type { MemoryService } from '../memory.service.js'
import { sanitizeFactFields, isToolArtifactNotification } from '../memory.types'
import type { EmbeddingService } from '../embedding/embedding.service.js'
import type { MemoryScope, ProposalInput, MemoryProposalRow, MemoryNodeLike } from '../contracts.js'
import { serializeProposal } from '../contracts.js'
import { getProposalApplier } from '../registry.js'

/**
 * §5.1 (#189): proposal lifecycle — propose/listPending/apply/reject/mark.
 * The ONLY entry point for extracted/summarized memories: nothing writes
 * the graph directly (design: BRAIN2_MEMORY_LIFECYCLE §3, §5.2).
 */
const log = makeLogger('memory.proposal.service')

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

    // #844: skill 提案 PII 硬线(设计 §3.3)— 候选剧本落库前强制患者标识
    // 扫描,命中即拒(零静默脱敏)。轨迹/归纳输入本就零正文,这是第二道防线。
    if (input.kind === 'skill' && input.payload) {
      try {
        const { scanSkillPii } = await import('../../common/pii-scanner.js')
        const candidate = JSON.parse(input.payload) as any
        const skill = candidate?.skill || candidate
        const pii = scanSkillPii({
          name: String(skill?.name || ''),
          description: String(skill?.description || ''),
          steps: Array.isArray(skill?.steps) ? skill.steps.map(String) : [],
          promptTemplate: String(skill?.promptTemplate || skill?.prompt || ''),
        })
        if (!pii.clean) {
          const now2 = new Date().toISOString()
          return {
            id: `pii_${now2}`,
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
            rejectedReason: `PII 扫描命中，拒绝入库（${pii.hits.map((h) => h.kind).join(',')}）`,
            createdAt: now2,
            resolvedAt: now2,
            resolvedBy: 'system',
            appliedStableId: null,
            payload: null,
          }
        }
      } catch (err) {
        log.warn('skill payload PII scan skipped', { reason: (err as Error).message.slice(0, 120) })
      }
    }

    // #836-followup: 工具完成通知("已生成 xxx.pptx")不是知识 — 统一在
    // 闸门拦截,不建行、不进审核队列(压缩/聊天提取都从这里过)。
    if (isToolArtifactNotification(content)) {
      const now = new Date().toISOString()
      return {
        id: `dropped_${now}`,
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
        rejectedReason: '工具完成通知不作为记忆入库（自动过滤）',
        createdAt: now,
        resolvedAt: now,
        resolvedBy: 'system',
      }
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
        relatedFacts: input.relatedFacts && input.relatedFacts.length > 0 ? JSON.stringify(input.relatedFacts) : null,
        payload: input.payload ? input.payload.slice(0, 12 * 1024) : null,
        status: 'pending',
        createdAt: now,
      },
    })
    const serialized = serializeProposal(row)

    // #839: fast-track for high-confidence EXPLICIT writes — the gate checks
    // above (artifact filter, semantic dedup, conflict marking) already ran,
    // so commit through the SAME applier human approvals use and keep the row
    // as the audit record. Any failure degrades to the normal review queue.
    if (input.fastTrack) {
      try {
        const node = await this.applyApproved(serialized)
        if (node) {
          const resolvedAt = new Date().toISOString()
          const updated = await (prisma as any).memoryProposal.updateMany({
            where: { id: row.id, status: 'pending' },
            data: { status: 'approved', resolvedAt, resolvedBy: 'fast-track' },
          })
          if (updated.count > 0) {
            return { ...serialized, status: 'approved', resolvedAt, resolvedBy: 'fast-track', appliedStableId: node.stableId }
          }
        }
      } catch (err) {
        log.warn('fast-track apply failed; falling back to review queue', { reason: (err as Error).message.slice(0, 120) })
      }
    }

    try {
      // #666: approval request enqueued via the module-level hook (wired by
      // user-context) — memory layer never imports modules/*.
      const { getProposalCreatedHandler } = await import('../registry.js')
      const handler = getProposalCreatedHandler()
      if (handler) {
        await handler(this.userId, serialized)
      }
    } catch (err) {
      log.warn('approval request enqueue skipped', { reason: (err as Error).message.slice(0, 120) })
    }
    return serialized
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
        type: proposal.kind === 'summary' ? 'summary' : 'fact',
        content: proposal.content,
        patientHash: proposal.patientHash || (node as any).patientHash,
        studyId: proposal.studyId || (node as any).studyId,
      })
    }
    return node
  }
}
