import { describe, test, expect, beforeEach } from 'vitest'
import {
  handleKnowledgeCommand,
  executeCommand,
  keywordSearch,
  extractFactFromPayload,
  type CommandContext,
  type LLMSummarizer,
} from '../../src/modules/knowledge/knowledge-command-handler'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores'
import { InMemoryKnowledgeGapService } from '../../src/modules/knowledge/knowledge-gap.service'
import fs from 'fs'
import path from 'path'
import os from 'os'

function createTestContext(extra?: Partial<CommandContext>): CommandContext {
  const baseDir = path.join(os.tmpdir(), `nexus-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(baseDir, { recursive: true })

  return {
    workspaceId: 'ws_test',
    userId: 'user_test',
    factsStore: new FactsStore(baseDir),
    knowledgeStore: new KnowledgeStore(baseDir),
    gapService: new InMemoryKnowledgeGapService(),
    ...extra,
  }
}

describe('knowledge-command-handler', () => {
  describe('handleKnowledgeCommand — dispatch', () => {
    test('unknown query returns error', async () => {
      const ctx = createTestContext()
      const result = await handleKnowledgeCommand(ctx, 'ZL 的 CT 结果怎么样')
      expect(result.type).toBe('error')
    })

    test('routes kb_search to search handler', async () => {
      const ctx = createTestContext()
      ctx.factsStore.add({ category: 'fact', importance: 5, content: 'NSCLC immunotherapy advances', sourceType: 'general' })

      const result = await handleKnowledgeCommand(ctx, '搜索知识库关于 NSCLC')
      expect(result.type).toBe('kb_search_result')
      expect(result.items.length).toBeGreaterThan(0)
    })
  })

  describe('executeCommand — kb_search', () => {
    let ctx: CommandContext

    beforeEach(() => {
      ctx = createTestContext()
      ctx.factsStore.add({ category: 'fact', importance: 5, content: 'EGFR T790M mutation treated with osimertinib', sourceType: 'general' })
      ctx.factsStore.add({ category: 'fact', importance: 4, content: 'NSCLC immunotherapy checkpoint inhibitors', sourceType: 'general' })
      ctx.knowledgeStore.add({ title: 'EGFR Management', content: 'First-line osimertinib for EGFR mutated NSCLC', sources: [] })
    })

    test('finds facts and knowledge articles', async () => {
      const result = await executeCommand(ctx, 'kb_search', 'EGFR osimertinib')
      expect(result.type).toBe('kb_search_result')
      const items = (result as any).items as any[]
      expect(items.length).toBeGreaterThanOrEqual(2)
      expect(items.some(i => i.kind === 'fact')).toBe(true)
      expect(items.some(i => i.kind === 'knowledge')).toBe(true)
      expect(items[0].score).toBeGreaterThanOrEqual(items[items.length - 1].score)
    })

    test('empty payload returns error', async () => {
      const result = await executeCommand(ctx, 'kb_search', '')
      expect(result.type).toBe('error')
    })

    test('no matches returns empty result', async () => {
      const result = await executeCommand(ctx, 'kb_search', 'xyz123nonexistent')
      expect(result.type).toBe('kb_search_result')
      expect((result as any).items).toEqual([])
      expect((result as any).summary).toContain('没有找到')
    })
  })

  describe('executeCommand — kb_remember', () => {
    let ctx: CommandContext

    beforeEach(() => {
      ctx = createTestContext()
    })

    test('saves clear assertion as fact', async () => {
      const result = await executeCommand(ctx, 'kb_remember', 'ZQ 对 osimertinib 不耐受')
      expect(result.type).toBe('kb_remembered')
      const r = result as any
      expect(r.factId).toBeTruthy()
      expect(r.confidence).toBe(0.92)

      const fact = ctx.factsStore.all()[0]
      expect(fact.content).toBe('ZQ 对 osimertinib 不耐受')
      expect(fact.sourceType).toBe('doctor')
    })

    test('uncertain assertion goes to pending confirmation', async () => {
      const result = await executeCommand(ctx, 'kb_remember', '可能也许 ZQ 有点副作用')
      expect(result.type).toBe('kb_pending_confirmation')
      const r = result as any
      expect(r.confidence).toBeLessThan(0.85)
      expect(ctx.factsStore.all().length).toBe(0)
    })

    test('empty payload returns error', async () => {
      const result = await executeCommand(ctx, 'kb_remember', '')
      expect(result.type).toBe('error')
    })
  })

  describe('executeCommand — kb_summarize', () => {
    let ctx: CommandContext

    beforeEach(() => {
      ctx = createTestContext()
      ctx.factsStore.add({ category: 'fact', importance: 5, content: 'EGFR T790M: osimertinib', sourceType: 'general' })
      ctx.factsStore.add({ category: 'fact', importance: 4, content: 'EGFR 19del: osimertinib first-line', sourceType: 'general' })
    })

    test('uses LLM summarizer when available', async () => {
      const llm: LLMSummarizer = {
        summarize: async () => 'EGFR mutations are treated with osimertinib.',
      }
      const result = await executeCommand({ ...ctx, llm }, 'kb_summarize', 'EGFR 治疗')
      expect(result.type).toBe('kb_summary')
      const r = result as any
      expect(r.summary).toBe('EGFR mutations are treated with osimertinib.')
      expect(r.sources.length).toBeGreaterThan(0)
    })

    test('falls back to concatenation without LLM', async () => {
      const result = await executeCommand(ctx, 'kb_summarize', 'EGFR 治疗')
      expect(result.type).toBe('kb_summary')
      const r = result as any
      expect(r.summary).toContain('EGFR')
      expect(r.sources.length).toBeGreaterThan(0)
    })

    test('no relevant knowledge returns empty summary', async () => {
      const result = await executeCommand(ctx, 'kb_summarize', 'cardiology surgery')
      expect(result.type).toBe('kb_summary')
      const r = result as any
      expect(r.summary).toContain('没有找到')
      expect(r.sources).toEqual([])
    })

    test('empty payload returns error', async () => {
      const result = await executeCommand(ctx, 'kb_summarize', '')
      expect(result.type).toBe('error')
    })
  })

  describe('executeCommand — kb_gaps', () => {
    test('lists open gaps for workspace', async () => {
      const ctx = createTestContext()
      ctx.gapService.create({ workspaceId: 'ws_test', content: 'Q1', source: 'chat' })
      ctx.gapService.create({ workspaceId: 'ws_other', content: 'Q2', source: 'chat' })
      ctx.gapService.create({ workspaceId: 'ws_test', content: 'Q3', source: 'user' })

      const result = await executeCommand(ctx, 'kb_gaps', '')
      expect(result.type).toBe('kb_gaps')
      const gaps = (result as any).gaps as any[]
      expect(gaps.length).toBe(2)
      expect(gaps.every(g => g.workspaceId === 'ws_test')).toBe(true)
      expect(gaps.every(g => g.status === 'open')).toBe(true)
    })

    test('returns empty array when no gaps', async () => {
      const ctx = createTestContext()
      const result = await executeCommand(ctx, 'kb_gaps', '')
      expect(result.type).toBe('kb_gaps')
      expect((result as any).gaps).toEqual([])
    })
  })

  describe('keywordSearch', () => {
    test('ranks higher scores first', () => {
      const ctx = createTestContext()
      ctx.factsStore.add({ category: 'fact', importance: 3, content: ' Lung cancer immunotherapy', sourceType: 'general' })
      ctx.factsStore.add({ category: 'fact', importance: 3, content: 'NSCLC EGFR osimertinib management', sourceType: 'general' })
      ctx.knowledgeStore.add({ title: 'NSCLC', content: 'Treatment options for NSCLC', sources: [] })

      const results = keywordSearch('NSCLC treatment', ctx.factsStore, ctx.knowledgeStore)
      expect(results[0].score).toBeGreaterThanOrEqual(results[results.length - 1].score)
      expect(results.some(r => r.kind === 'knowledge')).toBe(true)
    })

    test('returns empty for no match', () => {
      const ctx = createTestContext()
      ctx.factsStore.add({ category: 'fact', importance: 3, content: 'some unrelated fact', sourceType: 'general' })
      const results = keywordSearch('cardiology', ctx.factsStore, ctx.knowledgeStore)
      expect(results).toEqual([])
    })
  })

  describe('extractFactFromPayload', () => {
    test('clear assertion has high confidence', () => {
      const result = extractFactFromPayload('ZQ 对 osimertinib 不耐受')
      expect(result.confidence).toBe(0.92)
    })

    test('uncertain assertion has low confidence', () => {
      const result = extractFactFromPayload('可能也许 ZQ 有点副作用')
      expect(result.confidence).toBe(0.72)
    })
  })
})
