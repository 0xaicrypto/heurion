import prisma from '../common/prisma.js'
import type { MemoryService } from './memory.service.js'
import type { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../evolution/stores'
import type { MemoryNode } from './memory.types'

// ── Types ──────────────────────────────────────────────────────

export type MemoryScope = { patientHash?: string; studyId?: string; global?: boolean }

export type ProposalKind = 'fact' | 'article' | 'episode_summary' | 'compaction_summary'

export interface ProposalInput {
  scopeType: 'patient' | 'global' | 'study'
  patientHash?: string
  studyId?: string
  kind: ProposalKind
  content: string
  importance?: number
  confidence?: 'high' | 'medium' | 'low'
  reason?: string
  sourceRange?: string
}

export interface MemoryProposalRow {
  id: string
  userId: string
  scopeType: string
  patientHash: string | null
  studyId: string | null
  kind: ProposalKind
  content: string
  importance: number
  confidence: string
  reason: string | null
  sourceRange: string | null
  status: 'pending' | 'approved' | 'rejected'
  rejectedReason: string | null
  createdAt: string
  resolvedAt: string | null
  resolvedBy: string | null
}

export interface FactView {
  stableId: string
  content: string
  category: string
  importance: number
  sourceType: string
  patientHash?: string
  studyId?: string
  daysAgo: number
}

export interface ContextBundle {
  persona: string
  patient?: { basicInfo: string; findings: string } | null
  episodes: Array<{ daysAgo: number; summary: string }>
  facts: FactView[]
  skills: Array<{ name: string; strategy: string; successCount: number; taskCount: number }>
}

/**
 * Applies an approved memory proposal to the per-user memory graph.
 * Registered by the user-context layer (which owns MemoryService instances).
 */
export type ProposalApplier = (userId: string, proposal: MemoryProposalRow) => MemoryNode | null

let proposalApplier: ProposalApplier | null = null

export function registerProposalApplier(fn: ProposalApplier): void {
  proposalApplier = fn
}

export function getProposalApplier(): ProposalApplier | null {
  return proposalApplier
}

// ── Gateway ────────────────────────────────────────────────────

/**
 * MemoryGraphGateway — the single facade for memory read/write.
 *
 * Reads (readContext) assemble the per-scope context bundle from the memory
 * graph + legacy stores. Writes go exclusively through propose() →
 * pending review → applyApproved()/rejectProposal(); there is no direct
 * write path for extracted memories (design: BRAIN2_MEMORY_LIFECYCLE §3, §5.2).
 */
export class MemoryGraphGateway {
  constructor(
    private userId: string,
    private memory: MemoryService,
    private facts: FactsStore,
    private episodes: EpisodesStore,
    private skills: SkillsStore,
    private knowledge: KnowledgeStore,
  ) {}

  /**
   * Create a pending memory proposal. This is the ONLY entry point for
   * extracted/summarized memories — nothing writes the graph directly.
   * Also enqueues an approval request so the existing Today/Brain review
   * inbox picks it up unchanged.
   */
  async propose(input: ProposalInput): Promise<MemoryProposalRow> {
    const now = new Date().toISOString()
    const row = await (prisma as any).memoryProposal.create({
      data: {
        userId: this.userId,
        scopeType: input.scopeType,
        patientHash: input.patientHash || null,
        studyId: input.studyId || null,
        kind: input.kind,
        content: input.content,
        importance: input.importance ?? 3,
        confidence: input.confidence ?? 'medium',
        reason: input.reason || null,
        sourceRange: input.sourceRange || null,
        status: 'pending',
        createdAt: now,
      },
    })
    try {
      const { createApprovalRequest } = await import('../modules/approvals/approval.service.js')
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

  /**
   * Apply an approved proposal to the memory graph (versioned write).
   * Uses the registered applier (which owns the per-user MemoryService).
   */
  applyApproved(proposal: MemoryProposalRow): MemoryNode | null {
    const applier = getProposalApplier()
    if (!applier) return null
    return applier(this.userId, proposal)
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

  /**
   * Session-end / compaction closure: summarize the conversation and route
   * the summary + extracted facts through the pending review queue
   * (BRAIN2_MEMORY_LIFECYCLE §6.3).
   *
   * @returns the generated summary (usable as runtime context immediately)
   *          and the number of proposals enqueued.
   */
  async summarize(
    input: {
      conversation: string
      sessionId: string
      patientHash?: string
      sinceIdx?: number
    },
  ): Promise<{ summary: string; proposals: number }> {
    const { deepseekChat, getApiKey } = await import('../common/llm.js')
    const apiKey = getApiKey()

    const prompt = `你是临床对话摘要器。把以下对话压缩为结构化摘要，保留：
- 患者标识与诊断结论（含鉴别诊断）
- 已做出的治疗决策与理由
- 用药/剂量变更
- 关键检查数值与趋势
- 未解决问题与待办（含时间节点）
- 用户偏好与约束

要求：中文输出；≤400 tokens；使用以下模板（每节保留，空节写"(none)"）：

## Objective
## 患者重要信息
## 决策与理由
## 已完成
## 进行中
## 阻塞
## 下一步
## 相关文件与检查

不要提及摘要过程本身。

对话：
${input.conversation.slice(0, 12000)}`

    const summary = await deepseekChat(
      [{ role: 'user', content: prompt }],
      apiKey,
      {
        model: process.env.DEEPSEEK_CHAT_MODEL || 'deepseek-v4-flash',
        maxTokens: 400,
        telemetryContext: { userId: this.userId, workspaceId: this.userId, action: 'memory.summarize' },
      },
    )

    if (!summary.trim()) return { summary: '', proposals: 0 }

    await this.propose({
      scopeType: input.patientHash ? 'patient' : 'global',
      patientHash: input.patientHash,
      kind: 'episode_summary',
      content: summary,
      importance: 3,
      confidence: 'high',
      reason: `Session summary (${input.sessionId})`,
      sourceRange: input.sinceIdx ? `sinceIdx=${input.sinceIdx}` : undefined,
    })

    return { summary, proposals: 1 }
  }

  // ── Context assembly (readContext) ───────────────────────────

  /**
   * Assemble the per-scope context bundle. Patient isolation rules
   * (BRAIN2_MEMORY_LIFECYCLE §4.2):
   *   - patient scope: own facts in full, cross-patient only importance>=4
   *     when budget allows, tagged with [patient: X]
   *   - global scope: all facts grouped by patient
   *   - study scope: only studyId-matched facts
   */
  readContext(scope: MemoryScope): ContextBundle {
    const allFacts = this.facts.all()

    const facts = scope.patientHash
      ? this.isolatePatientFacts(allFacts, scope.patientHash)
      : scope.studyId
        ? allFacts.filter((f) => f.studyId === scope.studyId)
        : allFacts

    const episodes = this.episodes.all()
      .map((ep) => ({ daysAgo: Math.round((Date.now() - ep.createdAt) / 86400_000), summary: ep.summary }))
      .sort((a, b) => a.daysAgo - b.daysAgo)
      .slice(0, 10)

    const skills = this.skills.all()
      .filter((s) => s.successCount > 0)
      .slice(0, 5)
      .map((s) => ({ name: s.name, strategy: s.bestStrategy, successCount: s.successCount, taskCount: s.taskCount }))

    return {
      persona: this.buildPersona(),
      patient: scope.patientHash ? this.buildPatientContext(scope.patientHash) : null,
      episodes,
      facts: facts.map((f) => ({
        stableId: f.id,
        content: f.content,
        category: f.category,
        importance: f.importance ?? 3,
        sourceType: f.sourceType,
        patientHash: f.patientHash,
        studyId: f.studyId,
        daysAgo: Math.round((Date.now() - (f.lastSeenAt || f.createdAt)) / 86400_000),
      })),
      skills,
    }
  }

  private isolatePatientFacts(allFacts: any[], patientHash: string): any[] {
    const own = allFacts.filter((f) => f.patientHash === patientHash)
    const cross = allFacts
      .filter((f) => f.patientHash && f.patientHash !== patientHash && (f.importance ?? 3) >= 4)
      .slice(0, 5)
    return [...own, ...cross]
  }

  private buildPersona(): string {
    const allFacts = this.facts.all()
    const prefs = allFacts.filter((f) => f.category === 'preference').sort((a, b) => (b.importance ?? 3) - (a.importance ?? 3)).slice(0, 5)
    const goals = allFacts.filter((f) => f.category === 'goal').slice(0, 3)
    const articles = this.knowledge.all().filter((k) => k.status === 'current').slice(0, 5)

    const parts = [
      'You are Heurion, a clinical AI assistant for oncology research.',
      'Be concise, evidence-based, and reference relevant patient data and accumulated knowledge.',
    ]
    if (prefs.length > 0) {
      parts.push('\nYour accumulated preferences:')
      for (const p of prefs) parts.push(`- ${p.content} (importance: ${p.importance ?? 3}/5)`)
    }
    if (goals.length > 0) {
      parts.push('\nActive goals:')
      for (const g of goals) parts.push(`- ${g.content}`)
    }
    if (articles.length > 0) {
      parts.push('\nYour knowledge base includes:')
      for (const k of articles) parts.push(`- ${k.title}`)
    }
    return parts.join('\n')
  }

  private buildPatientContext(patientHash: string): { basicInfo: string; findings: string } | null {
    try {
      const nodes = this.memory.graph.getAllNodes()
      const findings = nodes
        .filter((n: any) => n.type === 'fact' && n.patientHash === patientHash)
        .slice(0, 20)
        .map((n: any) => `[${n.category}] ${n.content}`)
      return {
        basicInfo: `Patient: ${patientHash}`,
        findings: findings.length > 0 ? findings.join('\n') : '',
      }
    } catch {
      return null
    }
  }
}

function serializeProposal(r: any): MemoryProposalRow {
  return {
    id: r.id,
    userId: r.userId,
    scopeType: r.scopeType,
    patientHash: r.patientHash,
    studyId: r.studyId,
    kind: r.kind,
    content: r.content,
    importance: r.importance,
    confidence: r.confidence,
    reason: r.reason,
    sourceRange: r.sourceRange,
    status: r.status,
    rejectedReason: r.rejectedReason,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
    resolvedBy: r.resolvedBy,
  }
}
