/**
 * §5.1 (#189): shared contracts for the memory subsystem services.
 * Kept separate from the gateway so services can import types without
 * creating circular dependencies.
 */
import type { FactNode, ArticleNode } from './memory.types'
import type { Fact } from '../evolution/stores'

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

export type MemoryNodeLike = FactNode | ArticleNode

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
  }
}

export function isLegacyFact(f: any): f is Fact {
  return typeof f?.content === 'string' && typeof f?.id === 'string'
}
