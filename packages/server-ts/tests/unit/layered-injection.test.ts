import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { buildPersona } from '../../src/common/persona.js'
import { MemoryProjection } from '../../src/retrieval/memory-projection.js'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores.js'
import { buildKnowledgeInjection } from '../../src/modules/knowledge/knowledge-inject.js'
import { CONTEXT_CONFIG } from '../../src/common/context-config.js'

/**
 * #814 — 分层注入策略:
 * 1. persona 类目收敛补 constraint(漏网类目);
 * 2. persona×layer3 去重 — 全局 identity 类 facts 不再落 layer3 碎片;
 * 3. layer3 降级"未成文记忆" — importance/时效阈值参数化 + 段文案;
 * 4. knowledge_inject article 优先于裸 facts。
 */

const DAY = 86400_000

function makeFact(over: Partial<Record<string, any>> = {}): any {
  return {
    content: 'fact content', category: 'fact', importance: 3,
    createdAt: Date.now(), sourceType: 'general', provenance: { sourceKind: 'chat' },
    ...over,
  }
}

describe('#814 persona 类目收敛 — constraint 进 persona', () => {
  test('constraint 类 facts 注入 persona(Active constraints 段)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-constraint-'))
    try {
      const facts = new FactsStore(baseDir)
      facts.add({ content: '不得向患者直接推荐处方药', category: 'constraint', importance: 5, sourceType: 'doctor' })
      facts.add({ content: '偏好中文回复', category: 'preference', importance: 3, sourceType: 'patient' })
      facts.commit()
      const persona = buildPersona(facts, new KnowledgeStore(baseDir))
      expect(persona).toContain('Active constraints')
      expect(persona).toContain('不得向患者直接推荐处方药')
      expect(persona).toContain('偏好中文回复')
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true })
    }
  })
})

describe('#814 layer3 降级 + persona×layer3 去重', () => {
  let baseDir: string
  let facts: FactsStore
  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer3-'))
    facts = new FactsStore(baseDir)
  })
  afterEach(() => fs.rmSync(baseDir, { recursive: true, force: true }))

  function project(allFactInputs: any[], config?: any) {
    const proj = new MemoryProjection(config)
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    return proj.project({
      userId: 'u1',
      patientHash: null,
      persona: 'persona',
      facts: allFactInputs,
      episodes: [],
      skills: [],
    }).finally(() => spy.mockRestore())
  }

  // λ=0.001 让注意力分数几乎不衰减 — 排除只可能来自 #814 降级规则
  // (与 score>0.02 截断隔离),锁定策略本身而非分数巧合。
  const FLAT_CONFIG = {
    maxTokens: 8000, layer2EpisodeDays: 7, recencyLambda: 0.001,
    patientContextTokens: 1000, reserveTokens: 500,
    layer3ImportanceMin: 4, layer3RecentDays: 14,
  }

  test('全局 preference/constraint/goal 不进 layer3(已进 persona);患者范围保留', async () => {
    facts.add({ content: '全局偏好:简洁回复', category: 'preference', importance: 5, sourceType: 'patient' })
    facts.add({ content: '患者偏好:下午复诊', category: 'preference', importance: 5, sourceType: 'patient', patientHash: 'p1' })
    facts.add({ content: '近期重要临床事实', category: 'fact', importance: 4, sourceType: 'patient' })
    facts.commit()
    const { systemPrompt } = await project(facts.all())
    expect(systemPrompt).not.toContain('全局偏好:简洁回复')
    expect(systemPrompt).toContain('患者偏好:下午复诊')
    expect(systemPrompt).toContain('近期重要临床事实')
  })

  test('降级:低重要性且超期 facts 不进投影;importance≥4 或近期保留', async () => {
    const old = Date.now() - 60 * DAY
    // FactsStore.add 强制盖 createdAt — 落库后回写以模拟旧事实
    const marginal = facts.add({ content: '边缘旧事实 marginal', category: 'fact', importance: 2, sourceType: 'general' })
    marginal.createdAt = old
    const critical = facts.add({ content: '高重要性旧事实 critical', category: 'fact', importance: 5, sourceType: 'general' })
    critical.createdAt = old
    facts.add({ content: '近期普通事实 fresh', category: 'fact', importance: 2, sourceType: 'general' })
    facts.commit()
    const { systemPrompt } = await project(facts.all(), FLAT_CONFIG)
    expect(systemPrompt).not.toContain('边缘旧事实 marginal')
    expect(systemPrompt).toContain('高重要性旧事实 critical')
    expect(systemPrompt).toContain('近期普通事实 fresh')
  })

  test('段文案明示碎片属性(未成文记忆)', async () => {
    facts.add({ content: '某个近期事实', category: 'fact', importance: 3, sourceType: 'general' })
    facts.commit()
    const { systemPrompt } = await project(facts.all())
    expect(systemPrompt).toContain('未成文记忆')
    expect(systemPrompt).toContain('可能已有文章覆盖')
    // 引用规则仍随段注入(#188 溯源纪律不回退)
    expect(systemPrompt).toContain('[置信度, 来源]')
  })

  test('阈值参数化生效(env 覆盖)', () => {
    expect(CONTEXT_CONFIG.projection.layer3ImportanceMin).toBe(4)
    expect(CONTEXT_CONFIG.projection.layer3RecentDays).toBe(14)
  })
})

describe('#814 knowledge_inject article 优先', () => {
  let baseDir: string
  beforeEach(() => { baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-first-')) })
  afterEach(() => fs.rmSync(baseDir, { recursive: true, force: true }))

  test('article 与 facts 同时命中 → article 排最前,facts 兜底', async () => {
    const facts = new FactsStore(baseDir)
    const knowledge = new KnowledgeStore(baseDir)
    facts.add({ content: 'EGFR 一线方案事实甲', category: 'fact', importance: 5, sourceType: 'research' })
    facts.add({ content: 'EGFR 一线方案事实乙', category: 'fact', importance: 5, sourceType: 'research' })
    facts.add({ content: 'EGFR 一线方案事实丙', category: 'fact', importance: 5, sourceType: 'research' })
    knowledge.add({ title: 'EGFR 一线文章', content: 'EGFR 一线方案文章内容', status: 'current', sourceType: 'research' })
    facts.commit(); knowledge.commit()

    const inj = await buildKnowledgeInjection('EGFR 一线方案', facts, knowledge, { maxItems: 2 })
    const lines = inj.split('\n').filter((l) => l.startsWith('- ['))
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain('[knowledge]')
    expect(lines[0]).toContain('EGFR 一线方案文章内容')
    expect(lines[1]).toContain('[fact')
  })

  test('仅 facts 命中 → 原有事实注入不受影响', async () => {
    const facts = new FactsStore(baseDir)
    const knowledge = new KnowledgeStore(baseDir)
    facts.add({ content: '只有事实命中的场景词组', category: 'fact', importance: 5, sourceType: 'research' })
    facts.commit(); knowledge.commit()
    const inj = await buildKnowledgeInjection('只有事实命中的场景词组', facts, knowledge)
    expect(inj).toContain('[fact')
    expect(inj).not.toContain('[knowledge]')
  })
})
