/**
 * #1030 — 记忆使用观察指标（admin-only 只读聚合）。
 *
 * 数据源：`MemoryUsageBus`（memory_usage_events 表，检索/引用/建议信号）+
 * 各用户 `eventLog`（gap 检测/回答）。仅返回计数/比率与材料标题，不含正文、
 * 不含患者数据。供 #1018（颗粒度自适应）观察期校准使用。
 */
import fs from 'fs'
import path from 'path'
import prisma from '../../common/prisma'
import { makeLogger } from '../../common/logger'
import { twinsBaseDir } from '../../lib/upload-path.js'

const log = makeLogger('admin.memory-metrics')

const DAY_MS = 86_400_000

export function clampDays(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 14
  return Math.min(Math.max(Math.round(n), 1), 90)
}

function sinceIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString()
}

export interface MemoryOverview {
  days: number
  totals: { events: number; users: number; sessions: number }
  byActionUnitType: Array<{ action: string; unitType: string; count: number }>
  daily: Array<{ date: string; action: string; count: number }>
}

export async function getMemoryOverview(daysRaw: unknown): Promise<MemoryOverview> {
  const days = clampDays(daysRaw)
  const since = sinceIso(days)
  const [byActionUnitType, daily, dist] = await Promise.all([
    prisma.memoryUsageEvent.groupBy({
      by: ['action', 'unitType'],
      where: { at: { gte: since } },
      _count: { _all: true },
    }),
    prisma.$queryRaw<Array<{ date: string; action: string; count: bigint }>>`
      SELECT substr(at, 1, 10) AS date, action, COUNT(*) AS count
      FROM memory_usage_events
      WHERE at >= ${since}
      GROUP BY date, action
      ORDER BY date ASC`,
    prisma.$queryRaw<Array<{ events: bigint; users: bigint; sessions: bigint }>>`
      SELECT COUNT(*) AS events,
             COUNT(DISTINCT user_id) AS users,
             COUNT(DISTINCT session_id) AS sessions
      FROM memory_usage_events
      WHERE at >= ${since}`,
  ])
  const d = dist[0]
  return {
    days,
    totals: {
      events: Number(d?.events ?? 0),
      users: Number(d?.users ?? 0),
      sessions: Number(d?.sessions ?? 0),
    },
    byActionUnitType: byActionUnitType
      .map((r) => ({ action: r.action, unitType: r.unitType, count: r._count._all }))
      .sort((a, b) => b.count - a.count),
    daily: daily.map((r) => ({ date: r.date, action: r.action, count: Number(r.count) })),
  }
}

export interface SuggestionMetrics {
  days: number
  suggested: number
  accepted: number
  dismissed: number
  /** accepted / (accepted + dismissed)；无终态时为 null。 */
  acceptRate: number | null
}

export async function getSuggestionMetrics(daysRaw: unknown): Promise<SuggestionMetrics> {
  const days = clampDays(daysRaw)
  const rows = await prisma.memoryUsageEvent.groupBy({
    by: ['action'],
    where: {
      at: { gte: sinceIso(days) },
      unitType: 'reference',
      action: { in: ['suggested', 'accepted', 'dismissed'] },
    },
    _count: { _all: true },
  })
  const count = (action: string) => rows.find((r) => r.action === action)?._count._all ?? 0
  const accepted = count('accepted')
  const dismissed = count('dismissed')
  const resolved = accepted + dismissed
  return {
    days,
    suggested: count('suggested'),
    accepted,
    dismissed,
    acceptRate: resolved > 0 ? accepted / resolved : null,
  }
}

export interface GapMetrics {
  days: number
  detected: number
  answered: number
  /** answered / detected；无检测时为 null。 */
  answerRate: number | null
  usersWithGaps: number
}

/** gap 事件落在各用户 eventLog（JSONL）— 逐用户扫描近 N 天，单用户失败跳过。 */
export async function getGapMetrics(daysRaw: unknown): Promise<GapMetrics> {
  const days = clampDays(daysRaw)
  const sinceMs = Date.now() - days * DAY_MS
  const users = await prisma.user.findMany({ select: { id: true } })
  let detected = 0
  let answered = 0
  let usersWithGaps = 0
  for (const u of users) {
    try {
      const file = path.join(twinsBaseDir(u.id), 'event_log.jsonl')
      if (!fs.existsSync(file)) continue
      let hasGap = false
      for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        if (!line) continue
        let e: { timestamp?: unknown; eventType?: unknown }
        try { e = JSON.parse(line) } catch { continue }
        if (typeof e.timestamp !== 'number' || e.timestamp < sinceMs) continue
        if (e.eventType === 'memory_gap_detected') { detected++; hasGap = true }
        else if (e.eventType === 'memory_gap_answered') answered++
      }
      if (hasGap) usersWithGaps++
    } catch (err) {
      log.warn('gap metrics user scan skipped', { userId: u.id, err: String(err).slice(0, 80) })
    }
  }
  return {
    days,
    detected,
    answered,
    answerRate: detected > 0 ? answered / detected : null,
    usersWithGaps,
  }
}

export interface ReferenceUsageMetrics {
  days: number
  items: Array<{ referenceId: string; kind: string; label: string; uses: number; sessions: number }>
}

export async function getReferenceMetrics(daysRaw: unknown, limitRaw: unknown): Promise<ReferenceUsageMetrics> {
  const days = clampDays(daysRaw)
  const parsedLimit = Number(limitRaw)
  const limit = Math.min(Math.max(Number.isFinite(parsedLimit) ? Math.round(parsedLimit) : 20, 1), 50)
  const rows = await prisma.$queryRaw<Array<{ unit_id: string; uses: bigint; sessions: bigint }>>`
    SELECT unit_id, COUNT(*) AS uses, COUNT(DISTINCT session_id) AS sessions
    FROM memory_usage_events
    WHERE at >= ${sinceIso(days)}
      AND unit_type = 'reference'
      AND action IN ('referenced', 'accepted')
    GROUP BY unit_id
    ORDER BY uses DESC
    LIMIT ${limit}`
  const ids = rows.map((r) => r.unit_id)
  const items = ids.length
    ? await prisma.referenceItem.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true, label: true } })
    : []
  const byId = new Map(items.map((i) => [i.id, i]))
  return {
    days,
    items: rows
      .filter((r) => byId.has(r.unit_id))
      .map((r) => ({
        referenceId: r.unit_id,
        kind: byId.get(r.unit_id)!.kind,
        label: byId.get(r.unit_id)!.label || '(untitled)',
        uses: Number(r.uses),
        sessions: Number(r.sessions),
      })),
  }
}
