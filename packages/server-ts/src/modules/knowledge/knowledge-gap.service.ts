/**
 * Knowledge Gap — 未解问题/知识缺口管理
 *
 * 用于追踪系统自动识别或用户标记的未解问题。
 */

import prisma from '../../common/prisma'
import type { Fact, KnowledgeArticle } from '../../evolution/stores'

export type GapStatus = 'open' | 'answered' | 'ignored'
export type GapSource = 'chat' | 'user' | 'sidecar'

export interface KnowledgeGap {
  id: string
  userId: string
  workspaceId: string
  content: string
  source: GapSource
  sourceId?: string
  status: GapStatus
  answerId?: string
  answerText?: string
  createdAt: string
  updatedAt: string
}

export interface CreateGapInput {
  userId: string
  workspaceId: string
  content: string
  source: GapSource
  sourceId?: string
}

export interface GapFilter {
  workspaceId: string
  status?: GapStatus | 'all'
}

export interface GapListOptions extends GapFilter {
  source?: GapSource | 'all'
  q?: string
  page?: number
  pageSize?: number
  sortBy?: 'createdAt' | 'updatedAt'
  sortOrder?: 'asc' | 'desc'
}

export interface PaginatedGaps {
  gaps: KnowledgeGap[]
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
}

export interface GapStats {
  total: number
  open: number
  answered: number
  ignored: number
  bySource: Record<string, number>
  resolutionRate: number
}

export interface KnowledgeGapService {
  create(input: CreateGapInput): Promise<KnowledgeGap>
  list(options: GapListOptions): Promise<PaginatedGaps>
  getById(id: string): Promise<KnowledgeGap | null>
  resolve(id: string, answer: string): Promise<KnowledgeGap | null>
  ignore(id: string): Promise<KnowledgeGap | null>
  getStats(workspaceId: string): Promise<GapStats>
  suggestAnswer(id: string, facts: Fact[], knowledge: KnowledgeArticle[]): Promise<string[]>
}

function mapPrismaToGap(row: any): KnowledgeGap {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    content: row.content,
    source: row.source as GapSource,
    sourceId: row.sourceId ?? undefined,
    status: row.status as GapStatus,
    answerId: row.answerId ?? undefined,
    answerText: row.answerText ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function matchesFilter(gap: KnowledgeGap, options: GapListOptions): boolean {
  if (options.status && options.status !== 'all' && gap.status !== options.status) return false
  if (options.source && options.source !== 'all' && gap.source !== options.source) return false
  if (options.q && !gap.content.toLowerCase().includes(options.q.toLowerCase())) return false
  return true
}

function sortGaps(gaps: KnowledgeGap[], sortBy: 'createdAt' | 'updatedAt', sortOrder: 'asc' | 'desc'): KnowledgeGap[] {
  const dir = sortOrder === 'asc' ? 1 : -1
  return gaps.slice().sort((a, b) => {
    const va = sortBy === 'updatedAt' ? a.updatedAt : a.createdAt
    const vb = sortBy === 'updatedAt' ? b.updatedAt : b.createdAt
    return dir * va.localeCompare(vb)
  })
}

function paginate<T>(items: T[], page: number, pageSize: number): { items: T[]; pagination: PaginatedGaps['pagination'] } {
  const total = items.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(Math.max(1, page), totalPages)
  const start = (safePage - 1) * pageSize
  return {
    items: items.slice(start, start + pageSize),
    pagination: { page: safePage, pageSize, total, totalPages },
  }
}

/**
 * Production-ready Prisma-backed KnowledgeGapService.
 */
export class PrismaKnowledgeGapService implements KnowledgeGapService {
  async create(input: CreateGapInput): Promise<KnowledgeGap> {
    const now = new Date().toISOString()
    const row = await (prisma as any).knowledgeGap.create({
      data: {
        userId: input.userId,
        workspaceId: input.workspaceId,
        content: input.content,
        source: input.source,
        sourceId: input.sourceId,
        status: 'open',
        createdAt: now,
        updatedAt: now,
      },
    })
    return mapPrismaToGap(row)
  }

  async list(options: GapListOptions): Promise<PaginatedGaps> {
    const where: any = { workspaceId: options.workspaceId }
    if (options.status && options.status !== 'all') {
      where.status = options.status
    }
    if (options.source && options.source !== 'all') {
      where.source = options.source
    }

    const rows = await (prisma as any).knowledgeGap.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })
    let gaps = rows.map(mapPrismaToGap)
    if (options.q) {
      gaps = gaps.filter(g => g.content.toLowerCase().includes(options.q!.toLowerCase()))
    }

    const page = options.page ?? 1
    const pageSize = options.pageSize ?? 50
    const sortBy = options.sortBy ?? 'createdAt'
    const sortOrder = options.sortOrder ?? 'desc'

    gaps = sortGaps(gaps, sortBy, sortOrder)
    const result = paginate(gaps, page, pageSize)
    return { gaps: result.items, pagination: result.pagination }
  }

  async getById(id: string): Promise<KnowledgeGap | null> {
    const row = await (prisma as any).knowledgeGap.findUnique({ where: { id } })
    return row ? mapPrismaToGap(row) : null
  }

  async resolve(id: string, answer: string): Promise<KnowledgeGap | null> {
    const existing = await this.getById(id)
    if (!existing) return null

    const row = await (prisma as any).knowledgeGap.update({
      where: { id },
      data: {
        status: 'answered',
        answerText: answer,
        updatedAt: new Date().toISOString(),
      },
    })
    return mapPrismaToGap(row)
  }

  async ignore(id: string): Promise<KnowledgeGap | null> {
    const existing = await this.getById(id)
    if (!existing) return null

    const row = await (prisma as any).knowledgeGap.update({
      where: { id },
      data: {
        status: 'ignored',
        updatedAt: new Date().toISOString(),
      },
    })
    return mapPrismaToGap(row)
  }

  async getStats(workspaceId: string): Promise<GapStats> {
    const rows = await (prisma as any).knowledgeGap.findMany({ where: { workspaceId } })
    const gaps = rows.map(mapPrismaToGap)
    const total = gaps.length
    const open = gaps.filter(g => g.status === 'open').length
    const answered = gaps.filter(g => g.status === 'answered').length
    const ignored = gaps.filter(g => g.status === 'ignored').length

    const bySource: Record<string, number> = {}
    for (const g of gaps) {
      bySource[g.source] = (bySource[g.source] || 0) + 1
    }

    const closed = answered + ignored
    return {
      total,
      open,
      answered,
      ignored,
      bySource,
      resolutionRate: closed > 0 ? answered / closed : 0,
    }
  }

  async suggestAnswer(id: string, facts: Fact[], knowledge: KnowledgeArticle[]): Promise<string[]> {
    const gap = await this.getById(id)
    if (!gap) return []

    const queryTerms = gap.content.toLowerCase().split(/\s+/).filter(t => t.length >= 2)
    if (queryTerms.length === 0) return []

    function score(text: string): number {
      const lower = text.toLowerCase()
      let hits = 0
      for (const t of queryTerms) {
        if (lower.includes(t)) hits++
      }
      return hits / queryTerms.length
    }

    const scored: { text: string; score: number }[] = []

    for (const f of facts) {
      const s = score(`${f.category} ${f.content}`)
      if (s > 0) scored.push({ text: f.content, score: s })
    }

    for (const k of knowledge) {
      const s = score(`${k.title} ${k.content}`)
      if (s > 0) scored.push({ text: `${k.title}: ${k.content.slice(0, 200)}`, score: s })
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(s => s.text)
  }
}

/**
 * 简单的 in-memory KnowledgeGapService 实现，供单元测试和早期开发使用。
 */
export class InMemoryKnowledgeGapService implements KnowledgeGapService {
  private gaps: KnowledgeGap[] = []

  async create(input: CreateGapInput): Promise<KnowledgeGap> {
    const now = new Date().toISOString()
    const gap: KnowledgeGap = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId: input.userId,
      workspaceId: input.workspaceId,
      content: input.content,
      source: input.source,
      sourceId: input.sourceId,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    }
    this.gaps.push(gap)
    return gap
  }

  async list(options: GapListOptions): Promise<PaginatedGaps> {
    let gaps = this.gaps.filter(g => {
      if (g.workspaceId !== options.workspaceId) return false
      if (options.status && options.status !== 'all' && g.status !== options.status) return false
      if (options.source && options.source !== 'all' && g.source !== options.source) return false
      if (options.q && !g.content.toLowerCase().includes(options.q.toLowerCase())) return false
      return true
    })

    const page = options.page ?? 1
    const pageSize = options.pageSize ?? 50
    const sortBy = options.sortBy ?? 'createdAt'
    const sortOrder = options.sortOrder ?? 'desc'

    gaps = sortGaps(gaps, sortBy, sortOrder)
    const result = paginate(gaps, page, pageSize)
    return { gaps: result.items, pagination: result.pagination }
  }

  async getById(id: string): Promise<KnowledgeGap | null> {
    return this.gaps.find(g => g.id === id) || null
  }

  async resolve(id: string, answer: string): Promise<KnowledgeGap | null> {
    const gap = await this.getById(id)
    if (!gap) return null
    gap.status = 'answered'
    gap.answerText = answer
    gap.updatedAt = new Date().toISOString()
    return gap
  }

  async ignore(id: string): Promise<KnowledgeGap | null> {
    const gap = await this.getById(id)
    if (!gap) return null
    gap.status = 'ignored'
    gap.updatedAt = new Date().toISOString()
    return gap
  }

  async getStats(workspaceId: string): Promise<GapStats> {
    const gaps = this.gaps.filter(g => g.workspaceId === workspaceId)
    const total = gaps.length
    const open = gaps.filter(g => g.status === 'open').length
    const answered = gaps.filter(g => g.status === 'answered').length
    const ignored = gaps.filter(g => g.status === 'ignored').length
    const bySource: Record<string, number> = {}
    for (const g of gaps) {
      bySource[g.source] = (bySource[g.source] || 0) + 1
    }
    const closed = answered + ignored
    return {
      total,
      open,
      answered,
      ignored,
      bySource,
      resolutionRate: closed > 0 ? answered / closed : 0,
    }
  }

  async suggestAnswer(id: string, facts: Fact[], knowledge: KnowledgeArticle[]): Promise<string[]> {
    const gap = await this.getById(id)
    if (!gap) return []

    const queryTerms = gap.content.toLowerCase().split(/\s+/).filter(t => t.length >= 2)
    if (queryTerms.length === 0) return []

    function score(text: string): number {
      const lower = text.toLowerCase()
      let hits = 0
      for (const t of queryTerms) {
        if (lower.includes(t)) hits++
      }
      return hits / queryTerms.length
    }

    const scored: { text: string; score: number }[] = []
    for (const f of facts) {
      const s = score(`${f.category} ${f.content}`)
      if (s > 0) scored.push({ text: f.content, score: s })
    }
    for (const k of knowledge) {
      const s = score(`${k.title} ${k.content}`)
      if (s > 0) scored.push({ text: `${k.title}: ${k.content.slice(0, 200)}`, score: s })
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(s => s.text)
  }
}
