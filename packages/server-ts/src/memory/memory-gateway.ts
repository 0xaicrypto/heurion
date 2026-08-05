import prisma from '../common/prisma.js'
import path from 'path'
import type { MemoryService } from './memory.service.js'
import type { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../evolution/stores'
import type { MemoryNode } from './memory.types'
import { EmbeddingIndex, normalizeVector } from './embedding-index.js'

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
  /** Extraction category (13.4F quality feedback stats). */
  category?: string
  /** Same-scope confirmed facts this proposal contradicts (§5.7) */
  conflictsWith?: Array<{ stableId: string; content: string }>
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
  category: string | null
  conflictsWith: string | null
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
 * Resolves the per-user memory stores. Registered once by the user-context
 * layer; the default proposal applier (below) uses it to apply approved
 * proposals to the graph.
 */
export type ContextResolver = (userId: string) => {
  memory: MemoryService
  facts: FactsStore
  episodes: EpisodesStore
  skills: SkillsStore
  knowledge: KnowledgeStore
} | null

let contextResolver: ContextResolver | null = null

export function registerContextResolver(fn: ContextResolver): void {
  contextResolver = fn
}

/**
 * Applies an approved memory proposal to the per-user memory graph.
 * Overridable for tests; default implementation uses the context resolver.
 */
export type ProposalApplier = (userId: string, proposal: MemoryProposalRow) => MemoryNode | null

let proposalApplier: ProposalApplier | null = null

export function registerProposalApplier(fn: ProposalApplier): void {
  proposalApplier = fn
}

export function getProposalApplier(): ProposalApplier | null {
  return proposalApplier
}

// Default applier: fact/article → memory service write via the resolver.
export function defaultProposalApplier(userId: string, proposal: MemoryProposalRow): MemoryNode | null {
  const ctx = contextResolver?.(userId)
  if (!ctx) return null
  // §5.7: approving a proposal that contradicts same-scope confirmed facts
  // IS the human verdict — supersede the old memories first (history kept),
  // then write the new fact.
  if (proposal.kind === 'fact' && proposal.conflictsWith) {
    try {
      const conflicts = JSON.parse(proposal.conflictsWith) as Array<{ stableId: string; content: string }>
      for (const c of conflicts) {
        if (ctx.memory.supersedeFact(c.stableId, `Superseded by approved proposal ${proposal.id}`, 'system')) {
          console.log(`[MEMORY] Superseded conflicting fact ${c.stableId} (approved proposal ${proposal.id})`)
        }
      }
    } catch (err) {
      console.log('[MEMORY] Conflict supersede skipped:', (err as Error).message.slice(0, 120))
    }
  }
  if (proposal.kind === 'fact') {
    return ctx.memory.addFact(
      {
        content: proposal.content,
        category: 'fact',
        importance: proposal.importance,
        patientHash: proposal.patientHash || undefined,
        sourceType: proposal.scopeType === 'patient' ? 'patient' : 'general',
        provenance: { sourceKind: 'proposal', sourceRef: proposal.id },
      },
      'system',
    )
  }
  if (proposal.kind === 'article') {
    return ctx.memory.addArticle(
      {
        title: proposal.content.split('\n')[0].slice(0, 120) || '知识文章',
        content: proposal.content,
        provenance: { sourceKind: 'proposal', sourceRef: proposal.id },
      },
      'system',
    )
  }
  return null
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
  private _embeddingIndex: EmbeddingIndex | null = null
  private _embed: ((texts: string[]) => Promise<number[][]>) | null = null

  constructor(
    private userId: string,
    private memory: MemoryService,
    private facts: FactsStore,
    private episodes: EpisodesStore,
    private skills: SkillsStore,
    private knowledge: KnowledgeStore,
    private embedFn?: (texts: string[]) => Promise<number[][]>,
  ) {}

  private embeddingIndex(): EmbeddingIndex {
    if (!this._embeddingIndex) {
      const baseDir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', this.userId)
      this._embeddingIndex = new EmbeddingIndex(baseDir)
    }
    return this._embeddingIndex
  }

  private async embedder(): Promise<(texts: string[]) => Promise<number[][]>> {
    if (this.embedFn) return this.embedFn
    if (!this._embed) {
      const { createAiProvider } = await import('../common/ai/ai-provider.js')
      const provider = createAiProvider()
      this._embed = (texts: string[]) => provider.embed(texts)
    }
    return this._embed
  }

  /** Embed text; returns null when the embedding service is unavailable. */
  private async embedOrNull(text: string): Promise<number[] | null> {
    try {
      const embed = await this.embedder()
      const vecs = await embed([text])
      return vecs[0] ?? null
    } catch (err) {
      console.log('[MEMORY] Embedding unavailable:', (err as Error).message.slice(0, 120))
      return null
    }
  }

  /**
   * Create a pending memory proposal. This is the ONLY entry point for
   * extracted/summarized memories — nothing writes the graph directly.
   * Also enqueues an approval request so the existing Today/Brain review
   * inbox picks it up unchanged. Semantic dedup: content that is too similar
   * (>= 0.95) to an existing record in the same scope is skipped.
   */
  async propose(input: ProposalInput): Promise<MemoryProposalRow> {
    // Semantic dedup against reviewed memories in the same scope.
    const contentVec = await this.embedOrNull(input.content)
    if (contentVec) {
      const similar = this.embeddingIndex().findMostSimilar(contentVec, {
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
          content: input.content,
          importance: input.importance ?? 3,
          confidence: input.confidence ?? 'medium',
          reason: input.reason || null,
          sourceRange: input.sourceRange || null,
          category: input.category || null,
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
    // §5.7: conflict markers must point at same-scope confirmed facts —
    // cross-scope markers (e.g. another patient) are dropped.
    const conflictsWith = this.filterSameScopeConflicts(input)
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
        category: input.category || null,
        conflictsWith: conflictsWith ? JSON.stringify(conflictsWith) : null,
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
   * §5.7 — keep only conflict markers that reference a confirmed fact in the
   * SAME scope as this proposal. Facts carry scope identity (patientHash /
   * studyId); cross-scope markers (e.g. a different patient) are not
   * contradictions and are dropped.
   */
  private filterSameScopeConflicts(
    input: ProposalInput,
  ): Array<{ stableId: string; content: string }> | null {
    if (!input.conflictsWith?.length || !this.memory) return input.conflictsWith?.length ? null : null
    const kept: Array<{ stableId: string; content: string }> = []
    for (const c of input.conflictsWith) {
      try {
        const node = this.memory.graph.getLatestByStableId(c.stableId) as any
        if (!node || node.type !== 'fact') continue
        const sameScope =
          (input.scopeType === 'patient' && node.patientHash === input.patientHash) ||
          (input.scopeType === 'study' && node.studyId === input.studyId) ||
          (input.scopeType === 'global' && !node.patientHash && !node.studyId)
        if (sameScope) kept.push({ stableId: c.stableId, content: c.content || node.content })
      } catch {
        // Unknown stableId — drop the marker.
      }
    }
    return kept.length > 0 ? kept : null
  }

  /**
   * Apply an approved proposal to the memory graph (versioned write) and
   * index its embedding (reviewed memories only enter RAG, §4.5).
   */
  async applyApproved(proposal: MemoryProposalRow): Promise<MemoryNode | null> {
    const applier = getProposalApplier()
    if (!applier) return null
    const node = applier(this.userId, proposal)
    if (node) {
      // Index the embedding (reviewed memories only enter RAG, §4.5).
      try {
        const vec = await this.embedOrNull(proposal.content)
        if (vec) {
          this.embeddingIndex().upsert({
            nodeId: node.id,
            stableId: node.stableId,
            type: proposal.kind === 'article' ? 'article' : 'fact',
            patientHash: proposal.patientHash || (node as any).patientHash || undefined,
            studyId: proposal.studyId || (node as any).studyId || undefined,
            contentHash: (node as any).contentHash || proposal.content.slice(0, 16),
            vector: vec,
            model: 'bge-m3',
            norm: normalizeVector(vec),
            updatedAt: Date.now(),
          })
        }
      } catch (err) {
        console.log('[MEMORY] Embedding index write skipped:', (err as Error).message.slice(0, 120))
      }
    }
    return node
  }

  /**
   * Semantic retrieval (Tier 2). Embeds the query and cosine-scans the
   * reviewed-memory index within the scope (patient isolation by default).
   * Returns node content previews so callers can inject them as context.
   */
  async retrieve(
    query: string,
    scope: MemoryScope,
    opts: { topK?: number; minScore?: number; includeCrossPatient?: boolean } = {},
  ): Promise<Array<{ stableId: string; content: string; type: string; score: number }>> {
    const vec = await this.embedOrNull(query)
    if (!vec) return []
    const hits = this.embeddingIndex().search(vec, {
      patientHash: scope.patientHash,
      studyId: scope.studyId,
      includeCrossPatient: opts.includeCrossPatient,
      topK: opts.topK ?? 5,
      minScore: opts.minScore ?? 0.35,
    })
    return hits.map((h) => {
      let content = h.record.contentHash
      try {
        const node = this.memory?.graph.getLatestByStableId(h.record.stableId) as any
        if (node?.content) content = node.content
      } catch { /* keep hash preview */ }
      return {
        stableId: h.record.stableId,
        content,
        type: h.record.type,
        score: h.score,
      }
    })
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
    category: r.category,
    conflictsWith: r.conflictsWith,
    status: r.status,
    rejectedReason: r.rejectedReason,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
    resolvedBy: r.resolvedBy,
  }
}
