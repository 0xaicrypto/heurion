/**
 * §5.1 (#189): shared contracts for the memory subsystem services.
 * Kept separate from the gateway so services can import types without
 * creating circular dependencies.
 */
import type { FactNode, SummaryNode } from './memory.types'

export type MemoryScope = { patientHash?: string; studyId?: string; global?: boolean }

/** #844: 'skill' — 轨迹归纳/capture/marketplace 产出的技能提案(payload 携带候选+证据链)。 */
export type ProposalKind = 'fact' | 'summary' | 'episode_summary' | 'compaction_summary' | 'skill'

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
  /**
   * #736/#748: source fact stableIds this proposal was synthesized from —
   * summary applier passes them to addSummary so `maybeSynthesizeSummary`'s
   * used-set can exclude already-covered facts (stops repeat synthesis).
   */
  relatedFacts?: string[]
  /**
   * #839: high-confidence EXPLICIT writes (kb_remember / gap answer / direct
   * summary) skip the review wait: the gate checks (artifact filter, semantic
   * dedup, conflict marking) still run, then the standard applier commits the
   * node immediately and the proposal row is kept as the audit record
   * (status 'approved', resolvedBy 'fast-track'). Machine-derived writes
   * (gap-research / sidecar / scan findings) must NOT set this — they stay
   * pending for human review.
   */
  fastTrack?: boolean
  /**
   * #844: skill 提案专用 — 完整候选 JSON(name/description/steps/promptTemplate/
   * triggers/taskKind/scope/source + evidence 证据链 + fingerprint)。原样落库
   * 不裁剪(上限 12KB),applier 审批通过时解析落图。
   */
  payload?: string
}

export interface MemoryProposalRow {
  id: string
  userId: string
  scopeType: 'patient' | 'global' | 'study'
  patientHash: string | null
  studyId: string | null
  kind: ProposalKind
  content: string
  importance: number
  confidence: 'high' | 'medium' | 'low'
  reason: string | null
  sourceRange: string | null
  category: string | null
  /** JSON-encoded array of { stableId, content } conflict markers (DB shape). */
  conflictsWith: string | null
  status: 'pending' | 'approved' | 'rejected'
  rejectedReason: string | null
  createdAt: string
  resolvedAt: string | null
  resolvedBy: string | null
  /** #736/#748: JSON-encoded string[] of source fact stableIds (summary synthesis provenance). */
  relatedFacts?: string | null
  /**
   * #839: fast-track only — stableId of the node written by the standard
   * applier when the proposal was auto-approved at propose() time. Not a DB
   * column; attached in-memory to the returned row. Null for normal
   * pending→reviewed proposals.
   */
  appliedStableId?: string | null
  /** #844: skill 提案候选 payload(JSON)— DB 列直通,其他 kind 为 null。 */
  payload?: string | null
}

export interface ContextBundle {
  persona: string
  patient: { basicInfo: string; findings: string } | null
  episodes: Array<{ daysAgo: number; summary: string }>
  facts: Array<{
    stableId: string
    content: string
    category: string
    importance: number
    sourceType: string
    patientHash?: string
    studyId?: string
    daysAgo: number
  }>
  skills: Array<{ name: string; strategy: string; successCount: number; taskCount: number }>
}

export type MemoryNodeLike = FactNode | SummaryNode

export function serializeProposal(r: any): MemoryProposalRow {
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
    relatedFacts: r.relatedFacts ?? null,
    appliedStableId: r.appliedStableId ?? null,
    payload: r.payload ?? null,
  }
}

