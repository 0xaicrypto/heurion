import type { EventLog } from '../core/event-log'
import type { FactsStore, KnowledgeStore } from '../evolution/stores'

export type MemoryNodeType = 'fact' | 'summary' | 'gap' | 'skill' | 'entity' | 'document'

export type MemoryNodeStatus = 'current' | 'stale' | 'superseded' | 'pending_review'

export type MemoryCreatedBy = 'system' | 'user' | 'sidecar' | 'import'

export interface Provenance {
  sourceKind: 'chat' | 'session' | 'document' | 'sidecar' | 'user' | 'system' | 'import' | 'proposal'
  sourceRef?: string
  sourceLocator?: Record<string, unknown>
  evidenceQuote?: string
  extractedBy?: string
  extractedAt?: number
  extractionModel?: string
  extractionPromptId?: string
  confidence?: number
}

export interface MemoryNodeBase {
  /** Unique ID for this version, e.g. `fact_abc@v2` */
  id: string
  /** Stable entity ID across versions, e.g. `fact_abc` */
  stableId: string
  type: MemoryNodeType
  ownerId: string
  status: MemoryNodeStatus
  content: string
  contentHash: string
  version: number
  previousVersionId?: string
  importance?: number
  createdAt: number
  updatedAt: number
  createdBy: MemoryCreatedBy
  provenance: Provenance
  embeddingRef?: string
  meta: Record<string, unknown>
}

export interface FactNode extends MemoryNodeBase {
  type: 'fact'
  category: 'preference' | 'fact' | 'constraint' | 'goal' | 'context'
    | 'diagnosis' | 'symptom' | 'exam' | 'medication' | 'allergy' | 'plan'
  patientHash?: string
  studyId?: string
  sourceType: 'patient' | 'doctor' | 'research' | 'general' | 'sidecar' | 'document'
  count: number
  confidence: number
  /** §4.2 (#187): auto-marked when confidence < 0.6 — surfaces low-certainty memories in the UI. */
  uncertain?: boolean
}

export interface SummaryNode extends MemoryNodeBase {
  type: 'summary'
  title: string
  sourceFacts: Array<{ nodeId: string; stableId: string; version: number; snapshot: string }>
  sourceDocuments?: string[]
  staleBecause?: string[]
}

export interface GapNode extends MemoryNodeBase {
  type: 'gap'
  query: string
  context?: string
  source: 'chat' | 'user' | 'sidecar' | 'system'
  sourceId?: string
  answerNodeId?: string
}

export interface SkillNode extends MemoryNodeBase {
  type: 'skill'
  taskKind: string
  bestStrategy: string
  taskCount: number
  successCount: number
  failureCount: number
}

export interface EntityNode extends MemoryNodeBase {
  type: 'entity'
  entityType: 'patient' | 'medication' | 'biomarker' | 'study' | 'anatomy' | 'concept'
  canonicalName: string
  aliases: string[]
}

export interface DocumentNode extends MemoryNodeBase {
  type: 'document'
  fileId: string
  sha256: string
  name: string
  mimeType: string
  patientHash?: string
  extractedFacts?: string[]
}

export type MemoryNode =
  | FactNode
  | SummaryNode
  | GapNode
  | SkillNode
  | EntityNode
  | DocumentNode

export interface MemoryRelation {
  id: string
  sourceId: string
  targetId: string
  relation:
    | 'derives_from'
    | 'depends_on'
    | 'answers'
    | 'mentions'
    | 'supersedes'
    | 'related_to'
  weight?: number
  createdAt: number
}

export interface MemoryGraphState {
  nodes: MemoryNode[]
  relations: MemoryRelation[]
}

export interface CurationPolicy {
  factDelete: 'soft' | 'hard'
  summaryOnFactDelete: 'stale' | 'supersede'
  staleGracePeriodMs: number
  minFactsForSummary: number
  documentDeleteAutoCleanup: boolean
}

export const DEFAULT_CURATION_POLICY: CurationPolicy = {
  factDelete: 'soft',
  summaryOnFactDelete: 'stale',
  staleGracePeriodMs: 7 * 24 * 60 * 60 * 1000,
  minFactsForSummary: 2,
  documentDeleteAutoCleanup: true,
}

export interface MemoryServiceDeps {
  eventLog: EventLog
  graph: {
    load(): MemoryGraphState
    save(state: MemoryGraphState): void
  }
  legacy: {
    facts: FactsStore
    knowledge: KnowledgeStore
  }
  ownerId: string
  policy?: CurationPolicy
}

export interface AddFactInput {
  content: string
  category?: FactNode['category']
  importance?: number
  sourceType?: FactNode['sourceType']
  patientHash?: string
  studyId?: string
  confidence?: number
  uncertain?: boolean
  provenance?: Partial<Provenance>
  createdBy?: MemoryCreatedBy
}

/** §4.2 (#187): whitelists + bounds applied at every fact write path. */
export const FACT_CATEGORIES: FactNode['category'][] = [
  'preference', 'fact', 'constraint', 'goal', 'context',
  'diagnosis', 'symptom', 'exam', 'medication', 'allergy', 'plan',
]
export const FACT_SOURCE_TYPES: FactNode['sourceType'][] = ['patient', 'doctor', 'research', 'general', 'sidecar', 'document']
export const FACT_CONTENT_MAX = 300

export function sanitizeFactFields(input: {
  content?: string
  category?: string
  sourceType?: string
  confidence?: number
  uncertain?: boolean
}): { content: string; category: FactNode['category']; sourceType: FactNode['sourceType']; uncertain: boolean } {
  return {
    content: String(input.content || '').slice(0, FACT_CONTENT_MAX),
    category: (FACT_CATEGORIES as string[]).includes(input.category || '') ? (input.category as FactNode['category']) : 'fact',
    sourceType: (FACT_SOURCE_TYPES as string[]).includes(input.sourceType || '') ? (input.sourceType as FactNode['sourceType']) : 'general',
    uncertain: typeof input.confidence === 'number' ? input.confidence < 0.6 : (input.uncertain ?? false),
  }
}

/**
 * #836-followup:工具完成通知不得成为记忆。
 *
 * 压缩/聊天提取会把「已生成 "xxx.pptx"。」「Rendered "y.docx".」这类
 * 插件执行回执当成知识沉淀(生产实例:Anlotinib_*.pptx.pptx 被立为
 * summary)。此类内容不是临床知识,在 propose 闸门统一拦截。
 */
export function isToolArtifactNotification(text: unknown): boolean {
  const s = String(text || '').slice(0, 160)
  if (!s) return false
  if (/^(已生成|已渲染|文件已生成|AI已生成|AI已渲染|已输出|成功生成)/.test(s)) {
    if (/\.(pptx?|docx?|pdf|md|csv|xlsx?|txt|json)\b/i.test(s)) return true
  }
  if (/^Rendered\s+["「']/.test(s)) return true
  return false
}

export interface EditFactInput {
  content?: string
  category?: FactNode['category']
  importance?: number
  sourceType?: FactNode['sourceType']
  patientHash?: string
  studyId?: string
}

export interface AddSummaryInput {
  title: string
  content: string
  sourceFactNodeIds?: string[]
  sourceFactStableIds?: string[]
  sourceDocuments?: string[]
  provenance?: Partial<Provenance>
  createdBy?: MemoryCreatedBy
}

export interface EditSummaryInput {
  title?: string
  content?: string
}

export interface AddDocumentInput {
  fileId: string
  sha256: string
  name: string
  mimeType: string
  patientHash?: string
  provenance?: Partial<Provenance>
}

export interface AddGapInput {
  query: string
  context?: string
  source: GapNode['source']
  sourceId?: string
  provenance?: Partial<Provenance>
}

/**
 * #305: cohesive node behavior — evolution predicates live with the node
 * types so service classes orchestrate instead of re-implementing status
 * logic (repeated `status === 'superseded'` checks across the codebase).
 */
export function isNodeSuperseded(node: MemoryNodeBase | null | undefined): boolean {
  return !!node && node.status === 'superseded'
}

export function isNodeStale(node: MemoryNodeBase | null | undefined): boolean {
  return !!node && node.status === 'stale'
}

/** A fact supersedes its own prior version when a newer version exists. */
export function isFactCurrent(fact: FactNode): boolean {
  return fact.status === 'current' && fact.count > 0
}

/** An summary is stale when any of its source facts were superseded. */
export function isSummaryStale(summary: SummaryNode, supersededFactStableIds: string[]): boolean {
  if (summary.status === 'superseded') return true
  return summary.sourceFacts.some((s) => supersededFactStableIds.includes(s.stableId))
}
