import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores.js'
import { buildKnowledgeInjection, KB_INJECT_HEADER } from '../../src/modules/knowledge/knowledge-inject.js'

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

  test('命中知识库 → 返回带来源的注入片段', () => {
    const { facts, knowledge } = makeStores()
    const inj = buildKnowledgeInjection('NSCLC 靶向治疗', facts, knowledge)
    expect(inj).toContain(KB_INJECT_HEADER)
    expect(inj).toContain('[knowledge]')
    expect(inj).toContain('EGFR-TKI')
  })

  test('不相关查询 → 不注入(空串)', () => {
    const { facts, knowledge } = makeStores()
    const inj = buildKnowledgeInjection('今天天气怎么样', facts, knowledge)
    expect(inj).toBe('')
  })

  test('上限控制: 最多 3 条 + 单条截断', () => {
    const { facts, knowledge } = makeStores()
    // 制造 5 条匹配
    for (let i = 0; i < 5; i++) {
      knowledge.add({ title: `肺癌研究 ${i}`, content: 'NSCLC 治疗相关讨论内容'.repeat(50), status: 'current', sourceType: 'research' })
    }
    knowledge.commit()
    const inj = buildKnowledgeInjection('NSCLC', facts, knowledge, { maxItems: 3, maxCharsPerItem: 100 })
    const items = inj.split('\n').filter((l) => l.startsWith('- ['))
    expect(items.length).toBeLessThanOrEqual(3)
  })

  test('空查询/空库 → 空串', () => {
    const facts = new FactsStore(baseDir)
    const knowledge = new KnowledgeStore(baseDir)
    expect(buildKnowledgeInjection('', facts, knowledge)).toBe('')
    expect(buildKnowledgeInjection('x', facts, knowledge)).toBe('')
  })
})