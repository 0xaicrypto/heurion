/**
 * Knowledge Gap — 未解问题/知识缺口管理
 *
 * 用于追踪系统自动识别或用户标记的未解问题。
 */

import prisma from '../../common/prisma'

export type GapStatus = 'open' | 'answered' | 'ignored'

export interface KnowledgeGap {
  id: string
  userId: string
  workspaceId: string
  content: string
  source: 'chat' | 'user' | 'sidecar'
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
  source: 'chat' | 'user' | 'sidecar'
  sourceId?: string
}

export interface GapFilter {
  workspaceId: string
  status?: GapStatus | 'all'
}

export interface KnowledgeGapService {
  create(input: CreateGapInput): Promise<KnowledgeGap>
  list(filter: GapFilter): Promise<KnowledgeGap[]>
  getById(id: string): Promise<KnowledgeGap | null>
  resolve(id: string, answer: string): Promise<KnowledgeGap | null>
  ignore(id: string): Promise<KnowledgeGap | null>
}

function mapPrismaToGap(row: any): KnowledgeGap {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    content: row.content,
    source: row.source as KnowledgeGap['source'],
    sourceId: row.sourceId ?? undefined,
    status: row.status as GapStatus,
    answerId: row.answerId ?? undefined,
    answerText: row.answerText ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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

  async list(filter: GapFilter): Promise<KnowledgeGap[]> {
    const where: any = { workspaceId: filter.workspaceId }
    if (filter.status && filter.status !== 'all') {
      where.status = filter.status
    }

    const rows = await (prisma as any).knowledgeGap.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })
    return rows.map(mapPrismaToGap)
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

  async list(filter: GapFilter): Promise<KnowledgeGap[]> {
    return this.gaps.filter(g => {
      if (g.workspaceId !== filter.workspaceId) return false
      if (filter.status && filter.status !== 'all' && g.status !== filter.status) return false
      return true
    })
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
}
