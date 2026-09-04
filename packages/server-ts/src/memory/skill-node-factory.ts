/**
 * #842/#844 — SkillNode 工厂:统一 v2 节点构建(capture 迁移 / 归纳提案 /
 * marketplace install 共用)。字段白名单 + 长度截断都在这里收口。
 */
import { hashContent } from './node-base.js'
import type { SkillEvidence, SkillLifecycle, SkillNode, SkillScope, SkillSource } from './memory.types.js'

export interface SkillNodeInput {
  /** 固定 stableId(capture 迁移用 `skill_cap_*`;归纳用 `skill_ind_*`)。缺省自动生成。 */
  stableId?: string
  /** 溯源覆盖(capture 迁移指向 `captured_skill:<id>`,审计反查源行)。 */
  provenanceRef?: string
  name: string
  description: string
  steps: string[]
  promptTemplate: string
  taskKind: string
  triggers: string[]
  scope: SkillScope
  source: SkillSource
  evidence: SkillEvidence
  taskCount?: number
  successCount?: number
  failureCount?: number
  followRate?: number
  lifecycle?: SkillLifecycle
  /** #841 环⑤: toolsSequence 等运行元数据。 */
  meta?: Record<string, unknown>
}

export function buildSkillNode(ownerId: string, input: SkillNodeInput): SkillNode {
  const name = String(input.name || '').slice(0, 120)
  const description = String(input.description || '').slice(0, 300)
  const steps = (Array.isArray(input.steps) ? input.steps : []).map((s) => String(s).slice(0, 500)).slice(0, 20)
  const promptTemplate = String(input.promptTemplate || '').slice(0, 4000)
  const stableId = input.stableId || `skill_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const now = Date.now()
  return {
    id: `${stableId}@v1`,
    stableId,
    type: 'skill',
    ownerId,
    status: 'current',
    content: `${name}\n${description}`,
    contentHash: hashContent(`${name}|${steps.join('|')}|${promptTemplate}`),
    version: 1,
    name,
    description,
    steps,
    promptTemplate,
    taskKind: input.taskKind,
    triggers: input.triggers.map((t) => String(t).slice(0, 60)).slice(0, 10),
    scope: input.scope,
    evidence: {
      trajectoryIds: input.evidence.trajectoryIds.slice(0, 50),
      sessionIds: input.evidence.sessionIds.slice(0, 50),
      observationCount: input.evidence.observationCount,
      correctionRate: input.evidence.correctionRate,
    },
    source: input.source,
    taskCount: input.taskCount ?? 0,
    successCount: input.successCount ?? 0,
    failureCount: input.failureCount ?? 0,
    followRate: input.followRate ?? 0,
    lifecycle: input.lifecycle ?? 'active',
    bestStrategy: description || name,
    createdAt: now,
    updatedAt: now,
    createdBy: 'system',
    provenance: { sourceKind: 'system', sourceRef: input.provenanceRef ?? (input.stableId ? `skill:${stableId}` : undefined) },
    meta: input.meta ?? {},
  }
}

/**
 * #840-r5: skill 提案 payload 的唯一组装点(此前归纳/经验/捕捉三处内联
 * JSON.stringify,字段已现漂移:toolsSequence 仅归纳有)。与 parseSkillPayload
 * 构成对称往返:serialize 白名单 = parse 白名单。
 */
export interface SkillProposalCandidate {
  stableId?: string
  name: string
  description: string
  steps: string[]
  promptTemplate: string
  taskKind: string
  triggers: string[]
  scope: SkillScope
  source: SkillSource
  evidence: SkillEvidence
  /** #841 环⑤: 剧本声明的工具序列(归纳聚类)。 */
  toolsSequence?: string[]
  taskCount?: number
  successCount?: number
  failureCount?: number
  followRate?: number
}

export function buildSkillProposalPayload(candidate: SkillProposalCandidate, fingerprint: string): string {
  const skill: Record<string, unknown> = {
    name: candidate.name,
    description: candidate.description,
    steps: candidate.steps,
    promptTemplate: candidate.promptTemplate,
    taskKind: candidate.taskKind,
    triggers: candidate.triggers,
    scope: candidate.scope,
    source: candidate.source,
    evidence: candidate.evidence,
  }
  if (candidate.stableId) skill.stableId = candidate.stableId
  if (candidate.toolsSequence) skill.toolsSequence = candidate.toolsSequence
  if (candidate.taskCount !== undefined) skill.taskCount = candidate.taskCount
  if (candidate.successCount !== undefined) skill.successCount = candidate.successCount
  if (candidate.failureCount !== undefined) skill.failureCount = candidate.failureCount
  if (candidate.followRate !== undefined) skill.followRate = candidate.followRate
  return JSON.stringify({ skill, fingerprint })
}

/** 提案 payload → 构建入参(解析失败抛错,调用方决定降级)。 */export function parseSkillPayload(payload: string): { skill: SkillNodeInput; fingerprint?: string } {
  const parsed = JSON.parse(payload)
  const s = parsed?.skill || parsed
  if (!s?.name) throw new Error('skill payload missing name')
  const skill: SkillNodeInput = {
    stableId: s.stableId ? String(s.stableId) : undefined,
    name: String(s.name),
    description: String(s.description || ''),
    steps: Array.isArray(s.steps) ? s.steps.map(String) : [],
    promptTemplate: String(s.promptTemplate || s.prompt || ''),
    taskKind: String(s.taskKind || 'edit'),
    triggers: Array.isArray(s.triggers) ? s.triggers.map(String) : [],
    scope: s.scope === 'institution' ? 'institution' : 'personal',
    source: s.source === 'marketplace' ? 'marketplace' : s.source === 'synthesis' ? 'synthesis' : 'capture',
    evidence: {
      trajectoryIds: Array.isArray(s.evidence?.trajectoryIds) ? s.evidence.trajectoryIds.map(String) : [],
      sessionIds: Array.isArray(s.evidence?.sessionIds) ? s.evidence.sessionIds.map(String) : [],
      observationCount: Number(s.evidence?.observationCount) || 0,
      correctionRate: Number(s.evidence?.correctionRate) || 0,
    },
    taskCount: Number(s.taskCount) || 0,
    successCount: Number(s.successCount) || 0,
    failureCount: Number(s.failureCount) || 0,
    followRate: Number(s.followRate) || 0,
  }
  // #841 环⑤: 剧本声明的工具序列(归纳聚类指纹原文)→ 节点 meta,
  // 遵循度判定用(实际工具序列 ⊇ 声明序列)。
  if (Array.isArray(s.toolsSequence)) {
    skill.meta = { toolsSequence: s.toolsSequence.map(String) }
  }
  return { skill, fingerprint: parsed?.fingerprint }
}
