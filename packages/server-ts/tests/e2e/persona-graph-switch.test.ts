import { describe, test, expect } from 'vitest'
import { buildScenePersona } from '../../src/common/persona.js'
// #939: graphPersonaSource 下移 memory/persona-source(分层 #672),buildScenePersona 改收已渲染源。
import { graphPersonaSource } from '../../src/memory/persona-source.js'
import { MemoryService } from '../../src/memory/memory.service.js'
import { EventLog } from '../../src/core/event-log.js'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * #840 读路径第二批 — persona 与 layer3 facts 注入切 graph:
 * graph 提供时从单一事实源渲染(legacy 店留空也不丢数据),缺省回落不变。
 */

function makeMemory() {
  const baseDir = path.join(os.tmpdir(), `persona-graph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(baseDir, { recursive: true })
  return new MemoryService({
    eventLog: new EventLog(baseDir), baseDir,
    legacyFacts: new FactsStore(baseDir), legacyKnowledge: new KnowledgeStore(baseDir), ownerId: 'u_pers',
  })
}

describe('#840 persona / layer3 读路径切 graph', () => {
  test('graphPersonaSource:身份级事实 + current summaries 进入渲染源', () => {
    const memory = makeMemory()
    memory.addFact({ content: '医生偏好 AMA 引用格式', category: 'preference', importance: 4, sourceType: 'doctor' }, 'user')
    memory.addFact({ content: '患者张三的检验结果', category: 'fact', importance: 4, patientHash: 'ph_x', sourceType: 'patient' }, 'system')
    memory.addSummary({ title: 'EGFR 管理总结', content: '一线 osimertinib' }, 'system')

    const source = graphPersonaSource(memory as any)
    expect(source.facts.some((f) => f.content.includes('AMA'))).toBe(true)
    // 患者隔离:persona 源里可以有患者事实,但渲染层过滤(下一步断言)
    expect(source.summaries.some((s) => s.title.includes('EGFR'))).toBe(true)
  })

  test('buildScenePersona 传 memory:身份级信息从 graph 渲染,患者事实被隔离', () => {
    const memory = makeMemory()
    // legacy 店留空 — 数据只在 graph,证明渲染源已切
    memory.addFact({ content: '医生偏好简洁结论', category: 'preference', importance: 4, sourceType: 'doctor' }, 'user')
    memory.addSummary({ title: 'TKI 耐药总结', content: '' }, 'system')

    const persona = buildScenePersona('general', memory.legacyFacts as any, memory.legacyKnowledge as any, graphPersonaSource(memory))
    expect(persona).toContain('医生偏好简洁结论')
    expect(persona).toContain('TKI 耐药总结')
  })

  test('不传 memory:回落 legacy 渲染(行为不变)', () => {
    const baseDir = path.join(os.tmpdir(), `persona-legacy-${Date.now()}`)
    fs.mkdirSync(baseDir, { recursive: true })
    const facts = new FactsStore(baseDir)
    const knowledge = new KnowledgeStore(baseDir)
    facts.add({ content: '旧版偏好:表格输出', category: 'preference', importance: 4, sourceType: 'general' })
    knowledge.add({ title: '旧版总结', content: '', sources: [], status: 'current' })
    const persona = buildScenePersona('general', facts, knowledge)
    expect(persona).toContain('旧版偏好:表格输出')
    expect(persona).toContain('旧版总结')
  })
})
