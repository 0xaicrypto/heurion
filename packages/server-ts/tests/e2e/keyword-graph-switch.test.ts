import { describe, test, expect } from 'vitest'
import { GraphFactProvider, LegacyFactProvider } from '../../src/memory/fact-provider.js'
import { keywordSearch } from '../../src/retrieval/keyword-search.js'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores.js'
import { EventLog } from '../../src/core/event-log.js'
import { MemoryService } from '../../src/memory/memory.service.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * #840 — keyword 检索路切 graph:GraphFactProvider 读侧实现 + keywordSearch
 * 默认反转(graph 提供时从单一事实源取,legacy 仅作缺省回落)。
 */

function makeMemory(ownerId: string) {
  const baseDir = path.join(os.tmpdir(), `graph-kw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(baseDir, { recursive: true })
  const memory = new MemoryService({
    eventLog: new EventLog(baseDir),
    baseDir,
    legacyFacts: new FactsStore(baseDir),
    legacyKnowledge: new KnowledgeStore(baseDir),
    ownerId,
  })
  return memory
}

describe('GraphFactProvider', () => {
  test('graph 事实可检索,patientHash 过滤,superseded 排除', () => {
    const memory = makeMemory('u_gkw')
    const f1 = memory.addFact({ content: '患者 ZQ 对青霉素过敏', category: 'fact', importance: 4, patientHash: 'ph_1', sourceType: 'doctor' }, 'user')
    memory.addFact({ content: '全局:医院查房时间为每日 8 点', category: 'fact', importance: 3, sourceType: 'general' }, 'system')
    const f3 = memory.addFact({ content: '旧剂量方案每日 500mg', category: 'fact', importance: 3, patientHash: 'ph_1', sourceType: 'doctor' }, 'system')
    memory.supersedeFact(f3.stableId, '剂量调整', 'system')

    const provider = new GraphFactProvider(memory.graph)
    const all = provider.listCurrent()
    expect(all.some((f) => f.content.includes('青霉素过敏'))).toBe(true)
    expect(all.some((f) => f.content.includes('500mg'))).toBe(false) // superseded 排除
    const scoped = provider.listCurrent({ patientHash: 'ph_1' })
    expect(scoped.every((f) => f.patientHash === 'ph_1')).toBe(true)
    expect(scoped.some((f) => f.stableId === f1.stableId)).toBe(true)
    // factHash 口径与 legacy 一致(content|category|patientHash)
    expect(scoped[0].factHash).toContain('青霉素')
  })
})

describe('keywordSearch — graph 路径(#840)', () => {
  test('graph 提供时 facts/summaries 从 graph 取,legacy 空店不影响结果', () => {
    const baseDir = path.join(os.tmpdir(), `kw-graph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    fs.mkdirSync(baseDir, { recursive: true })
    // legacy 店故意留空 — 证明结果只能来自 graph
    const emptyFacts = new FactsStore(baseDir)
    const emptyKnowledge = new KnowledgeStore(baseDir)
    const memory = makeMemory('u_gkw2')
    memory.addFact({ content: 'EGFR T790M 突变使用 osimertinib', category: 'fact', importance: 5, sourceType: 'doctor' }, 'user')

    const results = keywordSearch('EGFR osimertinib', emptyFacts, emptyKnowledge, undefined, undefined, memory.graph)
    expect(results.some((r) => r.kind === 'fact' && r.content.includes('T790M'))).toBe(true)
    expect(results[0].source?.startsWith('fact:')).toBe(true)
    expect(results[0].stableId).toBeTruthy()
  })

  test('graph summary 节点进入 knowledge 命中', () => {
    const baseDir = path.join(os.tmpdir(), `kw-graph2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    fs.mkdirSync(baseDir, { recursive: true })
    const emptyFacts = new FactsStore(baseDir)
    const emptyKnowledge = new KnowledgeStore(baseDir)
    const memory = makeMemory('u_gkw3')
    memory.addSummary({ title: 'EGFR 管理总结', content: '一线 osimertinib 治疗 EGFR 突变 NSCLC' }, 'system')

    const results = keywordSearch('EGFR osimertinib', emptyFacts, emptyKnowledge, undefined, undefined, memory.graph)
    expect(results.some((r) => r.kind === 'knowledge' && r.content.includes('EGFR 管理总结'))).toBe(true)
  })

  test('未传 graph:回落 legacy 路径(行为不变)', () => {
    const baseDir = path.join(os.tmpdir(), `kw-legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    fs.mkdirSync(baseDir, { recursive: true })
    const facts = new FactsStore(baseDir)
    const knowledge = new KnowledgeStore(baseDir)
    const legacy = new LegacyFactProvider(facts)
    facts.add({ content: 'EGFR T790M 用 osimertinib', category: 'fact', importance: 5, sourceType: 'general' })
    const results = keywordSearch('EGFR osimertinib', facts, knowledge, legacy)
    expect(results.length).toBeGreaterThan(0)
  })
})
