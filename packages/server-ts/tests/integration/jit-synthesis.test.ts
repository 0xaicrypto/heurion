import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores.js'
import { buildKnowledgeInjection, JIT_INJECT_HEADER, KB_CITATION_RULE } from '../../src/modules/knowledge/knowledge-inject.js'
import { maybeJitSynthesize, jitRecentlyAttempted } from '../../src/modules/knowledge/jit-synthesis.service.js'
import { CONTEXT_CONFIG } from '../../src/common/context-config.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

import { deepseekChat } from '../../src/common/llm.js'

/**
 * #815 — JIT 惰性合成:
 * - facts 簇无文章覆盖 → 读时综合(ephemeral,不落图谱);
 * - 异步经 pending 闸门沉淀待审(无直写);
 * - 同查询 TTL 内防抖;停用开关与最少事实数门槛。
 */

let baseDir: string
let memory: any
let prisma: any

beforeEach(async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jit-'))
  const { MemoryService } = await import('../../src/memory/memory.service.js')
  const { EventLog } = await import('../../src/core/event-log.js')
  memory = new MemoryService({
    eventLog: new EventLog(baseDir, 'user_jit'),
    baseDir, legacyFacts: new FactsStore(baseDir), legacyKnowledge: new KnowledgeStore(baseDir), ownerId: 'user_jit',
  })
  prisma = (await import('../../src/common/prisma.js')).default
  vi.mocked(deepseekChat).mockResolvedValue(JSON.stringify({
    title: 'JIT 综合结果',
    question: '查询问题',
    conclusion: '综合结论内容',
    evidence: [{ claim: '依据一', factIds: ['fact_aaa', 'fact_bbb', 'fact_ccc'], confidence: 'high' }],
    caveats: ['待审核'],
  }))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  fs.rmSync(baseDir, { recursive: true, force: true })
})

function factHits() {
  return [
    { stableId: 'fact_aaa', content: '事实一', importance: 4, sourceType: 'research' },
    { stableId: 'fact_bbb', content: '事实二', importance: 4, sourceType: 'research' },
    { stableId: 'fact_ccc', content: '事实三', importance: 3, sourceType: 'research' },
  ]
}

describe('#815 maybeJitSynthesize', () => {
  test('happy path: 返回综合内容 + 经 pending 闸门沉淀(无直写)', async () => {
    const out = await maybeJitSynthesize({ userId: 'user_jit', query: '长尾主题查询', memory, facts: factHits() })
    expect(out).not.toBeNull()
    expect(out).toContain('### 结论')

    // ephemeral:图谱无新 summary 节点
    expect(memory.graph.getCurrentNodesByType('summary').filter((a: any) => a.title === 'JIT 综合结果')).toHaveLength(0)

    // 沉淀走 pending 闸门(等待异步落库)
    await vi.waitFor(async () => {
      const row = await prisma.memoryProposal.findFirst({
        where: { userId: 'user_jit', kind: 'summary', status: 'pending', reason: { contains: 'JIT' } },
      })
      expect(row).toBeTruthy()
      const parsed = JSON.parse(row.relatedFacts)
      expect(parsed).toEqual(['fact_aaa', 'fact_bbb', 'fact_ccc'])
    }, { timeout: 5000 })
  }, 30000)

  test('facts 不足门槛 → null 且不调 LLM', async () => {
    const out = await maybeJitSynthesize({
      userId: 'user_jit', query: '另一查询主题', memory,
      facts: factHits().slice(0, CONTEXT_CONFIG.injection.jitMinFacts - 1),
    })
    expect(out).toBeNull()
    expect(deepseekChat).not.toHaveBeenCalled()
  })

  test('同查询 TTL 内防抖:第二次不调 LLM', async () => {
    await maybeJitSynthesize({ userId: 'user_jit', query: '防抖查询主题', memory, facts: factHits() })
    expect(deepseekChat).toHaveBeenCalledTimes(1)
    expect(jitRecentlyAttempted('user_jit', '防抖查询主题')).toBe(true)

    const second = await maybeJitSynthesize({ userId: 'user_jit', query: '防抖查询主题', memory, facts: factHits() })
    expect(second).toBeNull()
    expect(deepseekChat).toHaveBeenCalledTimes(1)
  })

  test('停用开关生效', async () => {
    const orig = CONTEXT_CONFIG.injection.jitEnabled
    try {
      ;(CONTEXT_CONFIG.injection as any).jitEnabled = false
      const out = await maybeJitSynthesize({ userId: 'user_jit', query: '停用查询主题', memory, facts: factHits() })
      expect(out).toBeNull()
      expect(deepseekChat).not.toHaveBeenCalled()
    } finally {
      ;(CONTEXT_CONFIG.injection as any).jitEnabled = orig
    }
  })
})

describe('#815 knowledge-inject JIT 接线', () => {
  function makeStores() {
    const facts = new FactsStore(baseDir)
    const knowledge = new KnowledgeStore(baseDir)
    for (const c of ['长尾事实甲', '长尾事实乙', '长尾事实丙']) {
      facts.add({ content: c, category: 'fact', importance: 5, sourceType: 'research' })
    }
    facts.commit(); knowledge.commit()
    return { facts, knowledge }
  }

  test('仅 facts 命中 + JIT hook → 注入 JIT 块', async () => {
    const { facts, knowledge } = makeStores()
    const jit = await buildKnowledgeInjection('长尾事实', facts, knowledge, {
      jitSynthesize: async () => 'JIT 综合内容',
    })
    expect(jit).toContain(JIT_INJECT_HEADER)
    expect(jit).toContain('JIT 综合内容')
    expect(jit).not.toContain(KB_CITATION_RULE)
  })

  test('文章已覆盖 → 不触发 JIT', async () => {
    const { facts, knowledge } = makeStores()
    knowledge.add({ title: '已覆盖文章', content: '长尾事实 相关综述', status: 'current', sourceType: 'research' })
    knowledge.commit()
    const jitFn = vi.fn(async () => '不该出现')
    const jit = await buildKnowledgeInjection('长尾事实', facts, knowledge, { jitSynthesize: jitFn })
    expect(jit).toContain('[knowledge]')
    expect(jit).not.toContain(JIT_INJECT_HEADER)
    expect(jitFn).not.toHaveBeenCalled()
  })

  test('未接线 hook → 行为不变', async () => {
    const { facts, knowledge } = makeStores()
    const jit = await buildKnowledgeInjection('长尾事实', facts, knowledge)
    expect(jit).not.toContain(JIT_INJECT_HEADER)
    expect(jit).toContain('[fact')
  })
})
