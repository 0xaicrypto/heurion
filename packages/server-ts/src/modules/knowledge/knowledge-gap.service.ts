/**
 * Knowledge Gap — 未解问题/知识缺口管理
 *
 * 用于追踪系统自动识别或用户标记的未解问题。
 * 当前为 in-memory 实现；Step 3 将扩展为 Prisma 持久化 + REST API。
 */

export type GapStatus = 'open' | 'answered' | 'ignored'

export interface KnowledgeGap {
  id: string
  workspaceId: string
  content: string
  source: 'chat' | 'user' | 'sidecar'
  sourceId?: string
  status: GapStatus
  answerId?: string
  createdAt: number
  updatedAt: number
}

export interface CreateGapInput {
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
  create(input: CreateGapInput): KnowledgeGap
  list(filter: GapFilter): KnowledgeGap[]
  getById(id: string): KnowledgeGap | null
  resolve(id: string, answer: string): KnowledgeGap | null
  ignore(id: string): KnowledgeGap | null
}

/**
 * 简单的 in-memory KnowledgeGapService 实现，供单元测试和早期开发使用。
 */
export class InMemoryKnowledgeGapService implements KnowledgeGapService {
  private gaps: KnowledgeGap[] = []

  create(input: CreateGapInput): KnowledgeGap {
    const now = Date.now()
    const gap: KnowledgeGap = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      ...input,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    }
    this.gaps.push(gap)
    return gap
  }

  list(filter: GapFilter): KnowledgeGap[] {
    return this.gaps.filter(g => {
      if (g.workspaceId !== filter.workspaceId) return false
      if (filter.status && filter.status !== 'all' && g.status !== filter.status) return false
      return true
    })
  }

  getById(id: string): KnowledgeGap | null {
    return this.gaps.find(g => g.id === id) || null
  }

  resolve(id: string, answer: string): KnowledgeGap | null {
    const gap = this.getById(id)
    if (!gap) return null
    gap.status = 'answered'
    gap.answerId = answer // simplified: stores answer text as answerId for in-memory
    gap.updatedAt = Date.now()
    return gap
  }

  ignore(id: string): KnowledgeGap | null {
    const gap = this.getById(id)
    if (!gap) return null
    gap.status = 'ignored'
    gap.updatedAt = Date.now()
    return gap
  }
}
