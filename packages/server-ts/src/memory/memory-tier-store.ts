/**
 * #1015（SECOND_BRAIN Phase C）— 记忆分层存储统一契约 MemoryTierStore。
 *
 * 设计文档 4.2/4.9：情景/语义/程序/引用四层记忆各自演进，升降级没有统一
 * 的「可见可纠正」保障。本模块定义 Facts/Summary/Persona 三层的统一接口：
 *
 *   read(query) / write(unit) / promote(unitId, from, to, reason) / demote(...)
 *
 * 内部存储形态不变（Facts/Summary 仍是图谱节点；Persona 仍是派生渲染），
 * 但 promote/demote 一律写 `memory_tier_events` 留痕（可在
 * /api/v1/memory/health 回溯，后续 Phase 可回滚）。
 *
 * 范围：Phase D（Skills #1016）与 Phase E（ReferenceItem #1017）各自实现
 * 同一接口后并入；Phase C 不改既有审批/合成行为。
 */
import prisma from '../common/prisma.js'
import { makeLogger } from '../common/logger.js'
import type { MemoryService } from './memory.service.js'
import type { FactNode, SummaryNode } from './memory.types.js'

const log = makeLogger('memory.tier-store')

export type MemoryTier = 'fact' | 'summary' | 'persona'

export interface MemoryTierUnit {
  id: string
  tier: MemoryTier
  /** 展示标签（fact → category；summary → title；persona → 'persona'）。 */
  label: string
  content: string
  meta?: Record<string, unknown>
}

export interface MemoryTierQuery {
  patientHash?: string
  studyId?: string
  limit?: number
}

export interface TierChangeEvent {
  id: string
  userId: string
  unitId: string
  fromTier: MemoryTier
  toTier: MemoryTier
  action: 'promote' | 'demote'
  reason: string
  at: string
}

/** 统一分层存储契约 — Facts/Summary/Persona 各自实现。 */
export interface MemoryTierStore {
  readonly tier: MemoryTier
  read(query?: MemoryTierQuery): Promise<MemoryTierUnit[]>
  write(unit: Omit<MemoryTierUnit, 'tier'>): Promise<void>
  promote(unitId: string, fromTier: MemoryTier, toTier: MemoryTier, reason: string): Promise<TierChangeEvent>
  demote(unitId: string, fromTier: MemoryTier, toTier: MemoryTier, reason: string): Promise<TierChangeEvent>
}

async function recordTierChange(input: {
  userId: string
  unitId: string
  fromTier: MemoryTier
  toTier: MemoryTier
  action: 'promote' | 'demote'
  reason: string
}): Promise<TierChangeEvent> {
  const at = new Date().toISOString()
  try {
    const row = await prisma.memoryTierEvent.create({
      data: {
        userId: input.userId,
        unitId: input.unitId,
        fromTier: input.fromTier,
        toTier: input.toTier,
        action: input.action,
        reason: String(input.reason || '').slice(0, 500),
        at,
      },
    })
    return {
      id: row.id, userId: row.userId, unitId: row.unitId,
      fromTier: row.fromTier as MemoryTier, toTier: row.toTier as MemoryTier,
      action: row.action as 'promote' | 'demote', reason: row.reason, at: row.at,
    }
  } catch (err) {
    // 留痕失败不阻断调用方（best-effort），但必须可见。
    log.warn('tier change trace failed (best-effort)', { unitId: input.unitId, err: String(err).slice(0, 120) })
    return { id: '', userId: input.userId, unitId: input.unitId, fromTier: input.fromTier, toTier: input.toTier, action: input.action, reason: input.reason, at }
  }
}

/** 留痕查询（health 面板 / 回滚入口）。 */
export async function listTierEvents(userId: string, limit = 20): Promise<TierChangeEvent[]> {
  const rows = await prisma.memoryTierEvent.findMany({
    where: { userId },
    orderBy: { at: 'desc' },
    take: Math.min(Math.max(1, limit), 200),
  }).catch(() => [])
  return rows.map((r) => ({
    id: r.id, userId: r.userId, unitId: r.unitId,
    fromTier: r.fromTier as MemoryTier, toTier: r.toTier as MemoryTier,
    action: r.action as 'promote' | 'demote', reason: r.reason, at: r.at,
  }))
}

abstract class BaseTierStore implements MemoryTierStore {
  abstract readonly tier: MemoryTier
  protected constructor(protected readonly userId: string) {}
  abstract read(query?: MemoryTierQuery): Promise<MemoryTierUnit[]>
  abstract write(unit: Omit<MemoryTierUnit, 'tier'>): Promise<void>

  protected change(
    action: 'promote' | 'demote',
    unitId: string,
    fromTier: MemoryTier,
    toTier: MemoryTier,
    reason: string,
  ): Promise<TierChangeEvent> {
    return recordTierChange({ userId: this.userId, unitId, fromTier, toTier, action, reason })
  }

  promote(unitId: string, fromTier: MemoryTier, toTier: MemoryTier, reason: string): Promise<TierChangeEvent> {
    return this.change('promote', unitId, fromTier, toTier, reason)
  }

  demote(unitId: string, fromTier: MemoryTier, toTier: MemoryTier, reason: string): Promise<TierChangeEvent> {
    return this.change('demote', unitId, fromTier, toTier, reason)
  }
}

/** Facts 层（图谱节点；write 仅限 system/审批 applier 路径，不绕审批）。 */
export class FactTierStore extends BaseTierStore {
  readonly tier = 'fact' as const
  constructor(userId: string, private readonly memory: MemoryService) {
    super(userId)
  }

  async read(query: MemoryTierQuery = {}): Promise<MemoryTierUnit[]> {
    let nodes = this.memory.graph.getCurrentNodesByType('fact') as FactNode[]
    if (query.patientHash) nodes = nodes.filter((n) => n.patientHash === query.patientHash)
    else if (query.studyId) nodes = nodes.filter((n) => n.studyId === query.studyId)
    if (query.limit && query.limit > 0) nodes = nodes.slice(0, query.limit)
    return nodes.map((n) => ({
      id: n.stableId,
      tier: 'fact' as const,
      label: n.category,
      content: n.content,
      meta: { importance: n.importance, patientHash: n.patientHash, studyId: n.studyId, sourceType: n.sourceType },
    }))
  }

  async write(unit: Omit<MemoryTierUnit, 'tier'>): Promise<void> {
    const meta = unit.meta ?? {}
    this.memory.addFact({
      content: unit.content,
      category: (meta.category as FactNode['category']) || 'fact',
      importance: typeof meta.importance === 'number' ? meta.importance : 3,
      sourceType: (meta.sourceType as FactNode['sourceType']) || 'general',
      ...(typeof meta.patientHash === 'string' ? { patientHash: meta.patientHash } : {}),
      ...(typeof meta.studyId === 'string' ? { studyId: meta.studyId } : {}),
    }, 'system')
  }
}

/** Summary 层（图谱文本节点）。 */
export class SummaryTierStore extends BaseTierStore {
  readonly tier = 'summary' as const
  constructor(userId: string, private readonly memory: MemoryService) {
    super(userId)
  }

  async read(query: MemoryTierQuery = {}): Promise<MemoryTierUnit[]> {
    let nodes = (this.memory.graph.getCurrentNodesByType('summary') as SummaryNode[])
      .filter((n) => n.status === 'current')
    if (query.limit && query.limit > 0) nodes = nodes.slice(0, query.limit)
    return nodes.map((n) => ({
      id: n.stableId,
      tier: 'summary' as const,
      label: n.title,
      content: n.content,
      meta: { sourceFacts: n.sourceFacts?.length ?? 0, staleBecause: n.staleBecause ?? [] },
    }))
  }

  async write(unit: Omit<MemoryTierUnit, 'tier'>): Promise<void> {
    this.memory.addSummary({
      title: unit.label || 'Summary',
      content: unit.content,
    }, 'system')
  }
}

/**
 * Persona 层（派生渲染，无独立持久形态）：
 *  - read：调用注入的渲染器（生产由 modules 层提供 buildCachedPersona 包装）；
 *  - write：no-op（Persona 由 Facts/Summary 渲染，禁止直写）；
 *  - promote/demote：留痕（audit-only，Phase F 接入触发/回滚）。
 */
export class PersonaTierStore extends BaseTierStore {
  readonly tier = 'persona' as const
  constructor(userId: string, private readonly render: () => string | Promise<string>) {
    super(userId)
  }

  async read(): Promise<MemoryTierUnit[]> {
    return [{ id: `persona:${this.userId}`, tier: 'persona' as const, label: 'persona', content: await this.render() }]
  }

  async write(): Promise<void> {
    // 派生视图 — 无持久写入点（设计红线：Persona 只能由 Facts/Summary 渲染）。
  }
}
