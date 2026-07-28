/**
 * Telemetry — lightweight, best-effort event recording for KB/Router observability.
 *
 * Design goals:
 * - Zero LLM calls.
 * - Fire-and-forget writes: telemetry must never fail a user request.
 * - In-memory implementation available for unit tests / offline mode.
 */

import prisma from '../../common/prisma'

export type TelemetryCategory = 'router' | 'kb_command' | 'gap' | 'sidecar' | 'plugin' | 'llm_cost'

export interface TelemetryInput {
  userId: string
  workspaceId: string
  category: TelemetryCategory
  action: string
  metadata?: Record<string, unknown>
}

export interface TelemetryEvent {
  id: string
  userId: string
  workspaceId: string
  category: TelemetryCategory
  action: string
  metadata?: Record<string, unknown>
  createdAt: string
}

export interface TelemetryFilter {
  workspaceId: string
  category?: TelemetryCategory
  action?: string
  from?: string
  to?: string
  limit?: number
}

export interface LlmCostDashboard {
  totalCalls: number
  totalTokens: number
  totalCostUsd: number
  byAction: Record<string, number>
  byModel: Record<string, { calls: number; tokens: number; costUsd: number }>
}

export interface TelemetryDashboard {
  totalEvents: number
  router: {
    byIntent: Record<string, number>
    llmFallbackRate: number
    ruleHitRate: number
  }
  kbCommands: Record<string, number>
  gaps: {
    created: number
    answered: number
    ignored: number
    autoResolved: number
    resolutionRate: number
  }
  llmCost: LlmCostDashboard
}

export interface TelemetryService {
  record(input: TelemetryInput): Promise<void>
  query(filter: TelemetryFilter): Promise<TelemetryEvent[]>
  dashboard(workspaceId: string, from?: string, to?: string): Promise<TelemetryDashboard>
  llmCostDashboard(from?: string, to?: string): Promise<LlmCostDashboard>
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function safeJsonParse(text: string | undefined | null): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Production telemetry service backed by Prisma.
 */
export class PrismaTelemetryService implements TelemetryService {
  async record(input: TelemetryInput): Promise<void> {
    try {
      await (prisma as any).telemetryEvent.create({
        data: {
          userId: input.userId,
          workspaceId: input.workspaceId,
          category: input.category,
          action: input.action,
          metadata: safeJsonStringify(input.metadata),
          createdAt: new Date().toISOString(),
        },
      })
    } catch {
      // Best-effort: never fail the caller.
    }
  }

  async query(filter: TelemetryFilter): Promise<TelemetryEvent[]> {
    const { workspaceId, category, action, from, to, limit } = filter
    const where: any = { workspaceId }
    if (category) where.category = category
    if (action) where.action = action
    if (from || to) {
      where.createdAt = {}
      if (from) where.createdAt.gte = from
      if (to) where.createdAt.lte = to
    }

    const rows: any[] = await (prisma as any).telemetryEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit ?? 100,
    })

    return rows.map((r: any) => ({
      id: r.id,
      userId: r.userId,
      workspaceId: r.workspaceId,
      category: r.category as TelemetryCategory,
      action: r.action,
      metadata: safeJsonParse(r.metadata),
      createdAt: r.createdAt,
    }))
  }

  async dashboard(workspaceId: string, from?: string, to?: string): Promise<TelemetryDashboard> {
    const where: any = { workspaceId }
    if (from || to) {
      where.createdAt = {}
      if (from) where.createdAt.gte = from
      if (to) where.createdAt.lte = to
    }

    const rows = await (prisma as any).telemetryEvent.findMany({ where })

    const byCategory = (cat: TelemetryCategory) => rows.filter((r: any) => r.category === cat)

    const routerRows = byCategory('router')
    const kbRows = byCategory('kb_command')
    const gapRows = byCategory('gap')

    const byIntent: Record<string, number> = {}
    let ruleHits = 0
    let fallbacks = 0
    for (const r of routerRows) {
      const action = r.action || 'mixed'
      byIntent[action] = (byIntent[action] || 0) + 1
      const meta = safeJsonParse(r.metadata)
      if (meta?.ruleHit) ruleHits++
      if (meta?.llmFallback) fallbacks++
    }

    const kbCommands: Record<string, number> = {}
    for (const r of kbRows) {
      kbCommands[r.action] = (kbCommands[r.action] || 0) + 1
    }

    const gaps = {
      created: gapRows.filter((r: any) => r.action === 'created').length,
      answered: gapRows.filter((r: any) => r.action === 'answered').length,
      ignored: gapRows.filter((r: any) => r.action === 'ignored').length,
      autoResolved: gapRows.filter((r: any) => r.action === 'auto_resolved').length,
      resolutionRate: 0,
    }
    const resolved = gaps.answered + gaps.autoResolved
    const closed = resolved + gaps.ignored
    gaps.resolutionRate = closed > 0 ? resolved / closed : 0

    const llmCost = this.aggregateLlmCost(rows)

    return {
      totalEvents: rows.length,
      router: {
        byIntent,
        llmFallbackRate: routerRows.length > 0 ? fallbacks / routerRows.length : 0,
        ruleHitRate: routerRows.length > 0 ? ruleHits / routerRows.length : 0,
      },
      kbCommands,
      gaps,
      llmCost,
    }
  }

  async llmCostDashboard(from?: string, to?: string): Promise<LlmCostDashboard> {
    const where: any = { category: 'llm_cost' }
    if (from || to) {
      where.createdAt = {}
      if (from) where.createdAt.gte = from
      if (to) where.createdAt.lte = to
    }

    const rows = await (prisma as any).telemetryEvent.findMany({ where })
    return this.aggregateLlmCost(rows)
  }

  private aggregateLlmCost(rows: any[]): LlmCostDashboard {
    const costRows = rows.filter((r: any) => r.category === 'llm_cost')
    const byAction: Record<string, number> = {}
    const byModel: Record<string, { calls: number; tokens: number; costUsd: number }> = {}
    let totalTokens = 0
    let totalCostUsd = 0

    for (const r of costRows) {
      byAction[r.action] = (byAction[r.action] || 0) + 1
      const meta = safeJsonParse(r.metadata) || {}
      const model = String(meta.model || 'unknown')
      const tokens = typeof meta.totalTokens === 'number' ? meta.totalTokens : 0
      const cost = typeof meta.costUsd === 'number' ? meta.costUsd : 0
      if (!byModel[model]) byModel[model] = { calls: 0, tokens: 0, costUsd: 0 }
      byModel[model].calls += 1
      byModel[model].tokens += tokens
      byModel[model].costUsd += cost
      totalTokens += tokens
      totalCostUsd += cost
    }

    return {
      totalCalls: costRows.length,
      totalTokens,
      totalCostUsd,
      byAction,
      byModel,
    }
  }
}

/**
 * In-memory telemetry service for unit tests and offline mode.
 */
export class InMemoryTelemetryService implements TelemetryService {
  private events: TelemetryEvent[] = []

  async record(input: TelemetryInput): Promise<void> {
    this.events.push({
      id: `tel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId: input.userId,
      workspaceId: input.workspaceId,
      category: input.category,
      action: input.action,
      metadata: input.metadata,
      createdAt: new Date().toISOString(),
    })
  }

  async query(filter: TelemetryFilter): Promise<TelemetryEvent[]> {
    const { workspaceId, category, action, from, to, limit } = filter
    let results = this.events.filter(e => e.workspaceId === workspaceId)
    if (category) results = results.filter(e => e.category === category)
    if (action) results = results.filter(e => e.action === action)
    if (from) results = results.filter(e => e.createdAt >= from)
    if (to) results = results.filter(e => e.createdAt <= to)
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return results.slice(0, limit ?? 100)
  }

  async dashboard(workspaceId: string, from?: string, to?: string): Promise<TelemetryDashboard> {
    const rows = (await this.query({ workspaceId, from, to }))

    const routerRows = rows.filter(r => r.category === 'router')
    const kbRows = rows.filter(r => r.category === 'kb_command')
    const gapRows = rows.filter(r => r.category === 'gap')

    const byIntent: Record<string, number> = {}
    let ruleHits = 0
    let fallbacks = 0
    for (const r of routerRows) {
      byIntent[r.action] = (byIntent[r.action] || 0) + 1
      if (r.metadata?.ruleHit) ruleHits++
      if (r.metadata?.llmFallback) fallbacks++
    }

    const kbCommands: Record<string, number> = {}
    for (const r of kbRows) {
      kbCommands[r.action] = (kbCommands[r.action] || 0) + 1
    }

    const created = gapRows.filter(r => r.action === 'created').length
    const answered = gapRows.filter(r => r.action === 'answered').length
    const ignored = gapRows.filter(r => r.action === 'ignored').length
    const autoResolved = gapRows.filter(r => r.action === 'auto_resolved').length
    const resolved = answered + autoResolved
    const closed = resolved + ignored

    const llmCost = this.aggregateLlmCost(rows)

    return {
      totalEvents: rows.length,
      router: {
        byIntent,
        llmFallbackRate: routerRows.length > 0 ? fallbacks / routerRows.length : 0,
        ruleHitRate: routerRows.length > 0 ? ruleHits / routerRows.length : 0,
      },
      kbCommands,
      gaps: {
        created,
        answered,
        ignored,
        autoResolved,
        resolutionRate: closed > 0 ? resolved / closed : 0,
      },
      llmCost,
    }
  }

  async llmCostDashboard(from?: string, to?: string): Promise<LlmCostDashboard> {
    let rows = this.events.filter(e => e.category === 'llm_cost')
    if (from) rows = rows.filter(e => e.createdAt >= from)
    if (to) rows = rows.filter(e => e.createdAt <= to)
    return this.aggregateLlmCost(rows)
  }

  private aggregateLlmCost(rows: TelemetryEvent[]): LlmCostDashboard {
    const costRows = rows.filter(r => r.category === 'llm_cost')
    const byAction: Record<string, number> = {}
    const byModel: Record<string, { calls: number; tokens: number; costUsd: number }> = {}
    let totalTokens = 0
    let totalCostUsd = 0

    for (const r of costRows) {
      byAction[r.action] = (byAction[r.action] || 0) + 1
      const meta = r.metadata || {}
      const model = String(meta.model || 'unknown')
      const tokens = typeof meta.totalTokens === 'number' ? meta.totalTokens : 0
      const cost = typeof meta.costUsd === 'number' ? meta.costUsd : 0
      if (!byModel[model]) byModel[model] = { calls: 0, tokens: 0, costUsd: 0 }
      byModel[model].calls += 1
      byModel[model].tokens += tokens
      byModel[model].costUsd += cost
      totalTokens += tokens
      totalCostUsd += cost
    }

    return {
      totalCalls: costRows.length,
      totalTokens,
      totalCostUsd,
      byAction,
      byModel,
    }
  }
}

/**
 * No-op telemetry service for environments where telemetry is disabled.
 */
export class NoopTelemetryService implements TelemetryService {
  async record(_input: TelemetryInput): Promise<void> {}
  async query(_filter: TelemetryFilter): Promise<TelemetryEvent[]> { return [] }
  async dashboard(_workspaceId: string, _from?: string, _to?: string): Promise<TelemetryDashboard> {
    return {
      totalEvents: 0,
      router: { byIntent: {}, llmFallbackRate: 0, ruleHitRate: 0 },
      kbCommands: {},
      gaps: { created: 0, answered: 0, ignored: 0, autoResolved: 0, resolutionRate: 0 },
      llmCost: { totalCalls: 0, totalTokens: 0, totalCostUsd: 0, byAction: {}, byModel: {} },
    }
  }
  async llmCostDashboard(_from?: string, _to?: string): Promise<LlmCostDashboard> {
    return { totalCalls: 0, totalTokens: 0, totalCostUsd: 0, byAction: {}, byModel: {} }
  }
}
