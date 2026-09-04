import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores.js'
import { buildKnowledgeInjection, applyBudgetTiers, KB_INJECT_HEADER, KB_CITATION_RULE } from '../../src/modules/knowledge/knowledge-inject.js'
import { factContentHash } from '../../src/common/fact-render.js'

describe('#621 knowledge injection', () => {
  let baseDir: string
  beforeEach(() => { baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-inject-')) })
  afterEach(() => fs.rmSync(baseDir, { recursive: true, force: true }))

  function makeStores() {
    const facts = new FactsStore(baseDir)
    const knowledge = new KnowledgeStore(baseDir)
    knowledge.add({ title: 'NSCLC 靶向治疗进展', content: '三代 EGFR-TKI 一线治疗显著延长 PFS。', status: 'current', sourceType: 'research' })
    knowledge.add({ title: '免疫治疗指南', content: 'PD-1 抑制剂用于驱动基因阴性 NSCLC。', status: 'current', sourceType: 'research' })
    facts.add({ content: '患者 ZQ 58 岁男性,cT1cN2M0 IIIA 期 NSCLC', category: 'fact', importance: 4, sourceType: 'patient' })
    facts.commit(); knowledge.commit()
    return { facts, knowledge }
  }

  test('命中知识库 → 返回带来源的注入片段', async () => {
    const { facts, knowledge } = makeStores()
    const inj = await buildKnowledgeInjection('NSCLC 靶向治疗', facts, knowledge)
    expect(inj).toContain(KB_INJECT_HEADER)
    expect(inj).toContain('[knowledge]')
    expect(inj).toContain('EGFR-TKI')
  })

  test('不相关查询 → 不注入(空串)', async () => {
    const { facts, knowledge } = makeStores()
    const inj = await buildKnowledgeInjection('今天天气怎么样', facts, knowledge)
    expect(inj).toBe('')
  })

  test('上限控制: 最多 3 条 + 单条截断', async () => {
    const { facts, knowledge } = makeStores()
    // 制造 5 条匹配
    for (let i = 0; i < 5; i++) {
      knowledge.add({ title: `肺癌研究 ${i}`, content: 'NSCLC 治疗相关讨论内容'.repeat(50), status: 'current', sourceType: 'research' })
    }
    knowledge.commit()
    const inj = await buildKnowledgeInjection('NSCLC', facts, knowledge, { maxItems: 3, maxCharsPerItem: 100 })
    const items = inj.split('\n').filter((l) => l.startsWith('- ['))
    expect(items.length).toBeLessThanOrEqual(3)
  })

  test('空查询/空库 → 空串', async () => {
    const facts = new FactsStore(baseDir)
    const knowledge = new KnowledgeStore(baseDir)
    expect(await buildKnowledgeInjection('', facts, knowledge)).toBe('')
    expect(await buildKnowledgeInjection('x', facts, knowledge)).toBe('')
  })
})

describe('#813 summary citation enrichment', () => {
  let baseDir: string
  beforeEach(() => { baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cite-meta-')) })
  afterEach(() => fs.rmSync(baseDir, { recursive: true, force: true }))

  function makeKnowledgeStores() {
    const facts = new FactsStore(baseDir)
    const knowledge = new KnowledgeStore(baseDir)
    knowledge.add({ title: 'NSCLC 靶向治疗进展', content: '三代 EGFR-TKI 一线治疗显著延长 PFS。', status: 'current', sourceType: 'research' })
    facts.commit(); knowledge.commit()
    return { facts, knowledge }
  }

  test('resolveSummary 接线 → 文章条目带标题/来源摘要,并附引用指令', async () => {
    const { facts, knowledge } = makeKnowledgeStores()
    const inj = await buildKnowledgeInjection('NSCLC 靶向治疗', facts, knowledge, {
      resolveSummary: () => ({ title: 'NSCLC 靶向治疗进展', stale: false, sourceSummary: 'fact_x[0.9,patient] fact_y[0.8,chat]' }),
    })
    expect(inj).toContain('《NSCLC 靶向治疗进展》')
    expect(inj).toContain('来源: fact_x[0.9,patient] fact_y[0.8,chat]')
    expect(inj).toContain(KB_CITATION_RULE)
  })

  test('stale 文章 → 注入带失效标注', async () => {
    const { facts, knowledge } = makeKnowledgeStores()
    const inj = await buildKnowledgeInjection('NSCLC 靶向治疗', facts, knowledge, {
      resolveSummary: () => ({ title: 'NSCLC 靶向治疗进展', stale: true, staleSummary: 'fact_x 已修订', sourceSummary: 'fact_x[0.9,patient]' }),
    })
    expect(inj).toContain('⚠️已过时(fact_x 已修订)')
    expect(inj).toContain('引用前注意时效')
  })

  test('未接线 resolveSummary → 保持原始渲染,无引用指令', async () => {
    const { facts, knowledge } = makeKnowledgeStores()
    const inj = await buildKnowledgeInjection('NSCLC 靶向治疗', facts, knowledge)
    expect(inj).not.toContain('《')
    expect(inj).not.toContain(KB_CITATION_RULE)
    expect(inj).toContain('[knowledge]')
  })

  test('只有 fact 命中 → 不附引用指令', async () => {
    const baseDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cite-'))
    try {
      const facts = new FactsStore(baseDir2)
      const knowledge = new KnowledgeStore(baseDir2)
      facts.add({ content: '患者 EGFR 突变阳性特殊标记词', category: 'fact', importance: 4, sourceType: 'patient' })
      facts.commit(); knowledge.commit()
      const inj = await buildKnowledgeInjection('EGFR 突变阳性特殊标记词', facts, knowledge, {
        resolveSummary: () => ({ title: 'T', stale: false, sourceSummary: '' }),
      })
      expect(inj).not.toContain(KB_CITATION_RULE)
    } finally {
      fs.rmSync(baseDir2, { recursive: true, force: true })
    }
  })
})

describe('#630 budget-adaptive tiers', () => {
  test('未提供 remainingBudget → 保持旧行为(3 × 4K)', async () => {
    const opts = applyBudgetTiers({}, 64000)
    expect(opts.maxItems).toBe(3)
    expect(opts.maxCharsPerItem).toBe(4096)
  })

  test('预算充足(>30%) → 3 条 × 4K', async () => {
    const opts = applyBudgetTiers({ remainingBudget: 30_000 }, 64000)
    expect(opts.maxItems).toBe(3)
    expect(opts.maxCharsPerItem).toBe(4096)
  })

  test('预算中等(10-30%) → 2 条 × 3K', async () => {
    const opts = applyBudgetTiers({ remainingBudget: 12_000 }, 64000)
    expect(opts.maxItems).toBe(2)
    expect(opts.maxCharsPerItem).toBe(3072)
  })

  test('预算紧张(≤10%) → 1 条 × 2K', async () => {
    const opts = applyBudgetTiers({ remainingBudget: 3_000 }, 64000)
    expect(opts.maxItems).toBe(1)
    expect(opts.maxCharsPerItem).toBe(2048)
  })

  test('buildKnowledgeInjection 传入剩余预算 → 紧张时条数减少', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-budget-'))
    try {
      const facts = new FactsStore(baseDir)
      const knowledge = new KnowledgeStore(baseDir)
      for (let i = 0; i < 5; i++) {
        knowledge.add({ title: `肺癌研究 ${i}`, content: `NSCLC 治疗相关讨论内容 ${i}`, status: 'current', sourceType: 'research' })
      }
      knowledge.commit()
      const rich = await buildKnowledgeInjection('NSCLC', facts, knowledge, { remainingBudget: 30_000 })
      const tight = await buildKnowledgeInjection('NSCLC', facts, knowledge, { remainingBudget: 3_000 })
      const count = (s: string) => s.split('\n').filter((l) => l.startsWith('- [')).length
      expect(count(rich)).toBeGreaterThan(count(tight))
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true })
    }
  })
})

describe('#627 cross-layer dedup + unified rendering', () => {
  test('excludeFactHashes 命中 → 该事实不重复注入,只补新事实', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-dedup-'))
    try {
      const facts = new FactsStore(baseDir)
      const knowledge = new KnowledgeStore(baseDir)
      facts.add({ content: '患者 EGFR 突变阳性', category: 'fact', importance: 4, sourceType: 'patient' })
      facts.add({ content: 'EGFR-TKI 三代一线治疗', category: 'fact', importance: 3, sourceType: 'research' })
      knowledge.add({ title: 'NSCLC 指南', content: 'EGFR 突变推荐靶向治疗。', status: 'current', sourceType: 'research' })
      facts.commit(); knowledge.commit()

      // layer3 已注入第一条事实 → 注入层应跳过它,但保留另一条 fact
      const injected = factContentHash(facts.all().find((f) => f.content.includes('突变'))!)
      const inj = await buildKnowledgeInjection('EGFR', facts, knowledge, { excludeFactHashes: new Set([injected]) })
      expect(inj).not.toContain('患者 EGFR 突变阳性')
      expect(inj).toContain('EGFR-TKI 三代一线治疗')
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true })
    }
  })

  test('fact 条目与 layer3 共用统一渲染格式(★/d ago)', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-format-'))
    try {
      const facts = new FactsStore(baseDir)
      const knowledge = new KnowledgeStore(baseDir)
      facts.add({ content: '肿瘤标志物升高', category: 'fact', importance: 4, sourceType: 'patient' })
      facts.commit()
      const inj = await buildKnowledgeInjection('肿瘤标志物', facts, knowledge)
      expect(inj).toMatch(/\[fact ★★★★\] 肿瘤标志物升高 \(\d+d ago\)/)
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true })
    }
  })
})

describe('#629 patient-scoped injection', () => {
  test('患者场景:只注入该患者 facts + 全局文章,不注入其他患者事实', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-patient-'))
    try {
      const facts = new FactsStore(baseDir)
      const knowledge = new KnowledgeStore(baseDir)
      facts.add({ content: '本患者 EGFR 突变阳性', category: 'fact', importance: 4, sourceType: 'patient', patientHash: 'p1' })
      facts.add({ content: '其他患者 ALK 融合', category: 'fact', importance: 4, sourceType: 'patient', patientHash: 'p2' })
      knowledge.add({ title: 'NSCLC 指南', content: 'EGFR 突变推荐靶向治疗。', status: 'current', sourceType: 'research' })
      facts.commit(); knowledge.commit()

      // p1 场景:查询词命中 p1 fact 与全局文章;p2 事实不进入
      const inj = await buildKnowledgeInjection('EGFR', facts, knowledge, { patientHash: 'p1' })
      expect(inj).toContain('本患者 EGFR 突变阳性')
      expect(inj).not.toContain('ALK 融合')
      expect(inj).toContain('NSCLC 指南')

      // p2 场景:反向隔离 — p1 事实不进入
      const inj2 = await buildKnowledgeInjection('ALK', facts, knowledge, { patientHash: 'p2' })
      expect(inj2).toContain('ALK 融合')
      expect(inj2).not.toContain('本患者 EGFR 突变阳性')
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true })
    }
  })

  test('无患者范围:事实不按患者过滤', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-nopatient-'))
    try {
      const facts = new FactsStore(baseDir)
      const knowledge = new KnowledgeStore(baseDir)
      facts.add({ content: '通用事实 EGFR 机制', category: 'fact', importance: 4, sourceType: 'research' })
      facts.add({ content: '患者 p1 的 EGFR 用药', category: 'fact', importance: 4, sourceType: 'patient', patientHash: 'p1' })
      facts.commit()
      const inj = await buildKnowledgeInjection('EGFR', facts, knowledge)
      expect(inj).toContain('通用事实 EGFR 机制')
      expect(inj).toContain('患者 p1 的 EGFR 用药')
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true })
    }
  })
})