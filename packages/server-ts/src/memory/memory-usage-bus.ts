/**
 * #1014（SECOND_BRAIN Phase B）— 记忆使用反馈总线（append-only）。
 *
 * 仿照 EventLog 的架构位置：记录「谁用了哪条记忆」的原始流，替代散落
 * 各表的局部计数器。`MemoryGranularityController`（#1013）与未来的自适应
 * 策略（#1018）只对接这一条总线。
 *
 * 本阶段接入 Facts/Summary 两类信号：
 *   - kb_search 命中的 fact/summary → action='retrieved'
 *   - 知识库摘要经引用弹层登记为引用材料 → action='referenced'
 * Skills / ReferenceItem（建议采纳等）分别属于 Phase D / Phase E。
 *
 * 写入 fire-and-forget（延迟敏感路径不 await，失败仅降级日志）；查询为
 * userId+unitId 聚合（uses/lastUsedAt/分动作计数）。
 */
import prisma from '../common/prisma.js'
import { makeLogger } from '../common/logger.js'

const log = makeLogger('memory.usage-bus')

export type MemoryUnitType = 'fact' | 'summary' | 'reference' | 'skill'
export type MemoryUsageAction = 'retrieved' | 'accepted' | 'dismissed' | 'referenced'

export interface MemoryUsageInput {
  userId: string
  unitType: MemoryUnitType
  unitId: string
  action: MemoryUsageAction
  sessionId?: string
  at?: string
}

/** append-only 写入 — fire-and-forget，不阻塞调用方响应。 */
export function recordMemoryUsage(input: MemoryUsageInput): void {
  if (!input.userId || !input.unitId) return
  void prisma.memoryUsageEvent.create({
    data: {
      userId: input.userId,
      unitType: input.unitType,
      unitId: input.unitId,
      action: input.action,
      sessionId: input.sessionId ?? null,
      at: input.at ?? new Date().toISOString(),
    },
  }).catch((err) => {
    log.warn('usage record skipped (best-effort)', {
      unitType: input.unitType, unitId: input.unitId, err: String(err).slice(0, 120),
    })
  })
}

export interface MemoryUsageStats {
  /** 总使用次数（任意 action）。 */
  uses: number
  retrieved: number
  referenced: number
  accepted: number
  dismissed: number
  /** 最近一次使用时间（ISO；无记录为 null）。 */
  lastUsedAt: string | null
}

function summarize(rows: Array<{ action: string; at: string }>): MemoryUsageStats {
  const stats: MemoryUsageStats = { uses: rows.length, retrieved: 0, referenced: 0, accepted: 0, dismissed: 0, lastUsedAt: null }
  for (const r of rows) {
    if (r.action === 'retrieved') stats.retrieved++
    else if (r.action === 'referenced') stats.referenced++
    else if (r.action === 'accepted') stats.accepted++
    else if (r.action === 'dismissed') stats.dismissed++
    if (!stats.lastUsedAt || r.at > stats.lastUsedAt) stats.lastUsedAt = r.at
  }
  return stats
}

/** 单条记忆的使用聚合（#1013 controller / #1018 数据源）。 */
export async function getUsageStats(userId: string, unitId: string): Promise<MemoryUsageStats> {
  const rows = await prisma.memoryUsageEvent.findMany({
    where: { userId, unitId },
    select: { action: true, at: true },
  }).catch(() => [] as Array<{ action: string; at: string }>)
  return summarize(rows)
}

/** 批量聚合（列表页排序等场景，避免 N 次查询）。 */
export async function getUsageStatsBulk(userId: string, unitIds: string[]): Promise<Map<string, MemoryUsageStats>> {
  const out = new Map<string, MemoryUsageStats>()
  const ids = [...new Set(unitIds.filter(Boolean))]
  if (ids.length === 0) return out
  const rows = await prisma.memoryUsageEvent.findMany({
    where: { userId, unitId: { in: ids } },
    select: { unitId: true, action: true, at: true },
  }).catch(() => [] as Array<{ unitId: string; action: string; at: string }>)
  const grouped = new Map<string, Array<{ action: string; at: string }>>()
  for (const r of rows) {
    const list = grouped.get(r.unitId) ?? []
    list.push({ action: r.action, at: r.at })
    grouped.set(r.unitId, list)
  }
  for (const id of ids) out.set(id, summarize(grouped.get(id) ?? []))
  return out
}
