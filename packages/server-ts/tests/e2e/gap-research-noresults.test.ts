import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getAuthUserId } from '../setup.js'
import { getUserContext } from '../../src/modules/chat/user-context.js'
import { GapResearchService } from '../../src/modules/knowledge/gap-research.service.js'
import type { WebSearchProvider, WebSearchResult } from '../../src/modules/knowledge/web-search.service.js'
import prisma from '../../src/common/prisma.js'

/**
 * #254: "no results" from gap research must never become a durable fact —
 * it pollutes the memory graph and poisons later LLM conclusions.
 */
function makeProvider(result: WebSearchResult): WebSearchProvider {
  return {
    name: 'test',
    search: async () => result,
  }
}

async function seedGap(userId: string, content: string) {
  const row = await (prisma as any).knowledgeGap.create({
    data: {
      userId,
      workspaceId: userId,
      content,
      source: 'chat',
      status: 'open',
      createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    },
  })
  return row.id
}

describe('gap research no-result handling (#254)', () => {
  beforeEach(async () => {
    await (prisma as any).knowledgeGap.deleteMany({})
    await (prisma as any).memoryProposal.deleteMany({})
  })

  afterEach(() => { vi.restoreAllMocks() })

  test('no-results search writes no fact and leaves the gap open', async () => {
    const userId = await getAuthUserId()
    const gapId = await seedGap(userId, '无文献主题示例')
    const ctx = getUserContext(userId)
    const factsBefore = ctx.memory.graph.getCurrentNodesByType('fact').length

    const service = new GapResearchService(makeProvider({ found: false, text: 'No PubMed articles found for "x".' }))
    await service.researchOpenGaps({ maxPerRun: 5, minAgeMs: 0 })

    const factsAfter = ctx.memory.graph.getCurrentNodesByType('fact').length
    expect(factsAfter).toBe(factsBefore)

    const gap = await (prisma as any).knowledgeGap.findFirst({ where: { id: gapId } })
    expect(gap.status).toBe('open')
  })

  test('found results still write the fact and resolve the gap', async () => {
    const userId = await getAuthUserId()
    const gapId = await seedGap(userId, 'EGFR 突变检测方法')
    const ctx = getUserContext(userId)
    const factsBefore = ctx.memory.graph.getCurrentNodesByType('fact').length

    const service = new GapResearchService(makeProvider({ found: true, text: 'PubMed search results for "EGFR":\n\n- Article title (Journal)' }))
    await service.researchOpenGaps({ maxPerRun: 5, minAgeMs: 0 })

    const factsAfter = ctx.memory.graph.getCurrentNodesByType('fact').length
    expect(factsAfter).toBe(factsBefore + 1)
    const newFact = ctx.memory.graph.getCurrentNodesByType('fact').find((n: any) => n.content.includes('PubMed search results'))
    expect(newFact).toBeDefined()

    const gap = await (prisma as any).knowledgeGap.findFirst({ where: { id: gapId } })
    expect(gap.status).toBe('answered')
  })
})
