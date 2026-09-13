import { describe, test, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * #1014 — kb_search 命中即写使用反馈（Facts/Summary 信号）。
 */
const usage = vi.hoisted(() => ({ recordMemoryUsage: vi.fn() }))
vi.mock('../../src/memory/memory-usage-bus.js', () => usage)

import { handleKnowledgeCommand } from '../../src/modules/knowledge/knowledge-command-handler.js'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores'
import { InMemoryKnowledgeGapService } from '../../src/modules/knowledge/knowledge-gap.service'

function createCtx(sessionId?: string) {
  const baseDir = path.join(os.tmpdir(), `nexus-usage-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(baseDir, { recursive: true })
  return {
    workspaceId: 'ws_1',
    userId: 'user_1',
    ...(sessionId ? { sessionId } : {}),
    factsStore: new FactsStore(baseDir),
    knowledgeStore: new KnowledgeStore(baseDir),
    gapService: new InMemoryKnowledgeGapService(),
  }
}

beforeEach(() => usage.recordMemoryUsage.mockReset())

describe('#1014 kb_search → MemoryUsageBus', () => {
  test('命中的 fact/summary 各写 retrieved（带 sessionId）', async () => {
    const ctx = createCtx('sess_1')
    ctx.factsStore.add({ category: 'fact', importance: 5, content: 'NSCLC immunotherapy checkpoint inhibitors', sourceType: 'general' })
    ctx.knowledgeStore.add({ title: 'EGFR Management', content: 'First-line osimertinib for EGFR mutated NSCLC', sources: [] })

    const res = await handleKnowledgeCommand(ctx, '搜索知识库关于 NSCLC')
    expect(res.type).toBe('kb_search_result')

    const calls = usage.recordMemoryUsage.mock.calls.map((c) => c[0])
    expect(calls.some((c: any) => c.unitType === 'fact' && c.action === 'retrieved' && c.sessionId === 'sess_1')).toBe(true)
    expect(calls.some((c: any) => c.unitType === 'summary' && c.action === 'retrieved')).toBe(true)
    // 每条记录都有 unitId
    expect(calls.every((c: any) => Boolean(c.unitId))).toBe(true)
  })

  test('无命中 → 不写反馈', async () => {
    const ctx = createCtx()
    const res = await handleKnowledgeCommand(ctx, '搜索知识库关于 nonexi_xyz')
    expect(res.type).toBe('kb_search_result')
    expect(usage.recordMemoryUsage).not.toHaveBeenCalled()
  })
})
