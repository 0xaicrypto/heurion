import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores'
import * as userContext from '../../src/modules/chat/user-context.js'
const { buildCachedPersona, buildPersona } = userContext

/**
 * K5 — Persona 缓存（#111）。persona 只依赖 facts + knowledge 的 commit
 * 版本：版本未变 → 复用缓存；任一变化 → 重建。
 */
describe('K5 persona cache', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-cache-'))
  })

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function makeStores() {
    const facts = new FactsStore(baseDir)
    const knowledge = new KnowledgeStore(baseDir)
    return { facts, knowledge }
  }

  test('#1 facts/articles 无变化 → persona 复用缓存，不重建', () => {
    const { facts, knowledge } = makeStores()

    const first = buildCachedPersona('user_a', facts, knowledge)
    const second = buildCachedPersona('user_a', facts, knowledge)

    // Same string reference → cached, not rebuilt
    expect(second).toBe(first)
  })

  test('#2 facts 变化 → persona 重建，新内容生效', () => {
    const { facts, knowledge } = makeStores()

    const before = buildCachedPersona('user_b', facts, knowledge)

    facts.add({ content: '医生偏好先评估分子分型再定方案', category: 'preference', importance: 4, sourceType: 'doctor' })
    facts.commit()

    const after = buildCachedPersona('user_b', facts, knowledge)

    expect(after).not.toBe(before)
    expect(after).toContain('分子分型')
  })

  test('#3 knowledge 变化 → persona 重建', () => {
    const { facts, knowledge } = makeStores()

    const before = buildCachedPersona('user_c', facts, knowledge)

    knowledge.add({ title: 'NSCLC 靶向治疗进展', content: '综述内容', status: 'current', sourceType: 'research' })
    knowledge.commit()

    const after = buildCachedPersona('user_c', facts, knowledge)

    expect(after).not.toBe(before)
    expect(after).toContain('NSCLC 靶向治疗进展')
  })

  test('不同用户缓存互相隔离：x 的缓存不被 y 的更新污染', () => {
    // Each user has their own stores in production (per-user baseDir) —
    // simulate that with two independent store pairs.
    const xStores = makeStores()
    const a = buildCachedPersona('user_x', xStores.facts, xStores.knowledge)

    const yStores = makeStores()
    yStores.facts.add({ content: '医生偏好先评估分子分型再定方案', category: 'preference', importance: 4, sourceType: 'doctor' })
    yStores.facts.commit()
    const b = buildCachedPersona('user_y', yStores.facts, yStores.knowledge)

    expect(b).toContain('分子分型')

    const a2 = buildCachedPersona('user_x', xStores.facts, xStores.knowledge)
    expect(a2).toBe(a)
    expect(a2).not.toContain('分子分型')
  })
})

describe('§13.3 persona scope isolation + ranking', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-scope-'))
  })

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  test('#1 患者 fact 不进全局 persona；医生偏好保留', () => {
    const facts = new FactsStore(baseDir)
    const knowledge = new KnowledgeStore(baseDir)
    facts.add({ content: '患者A对青霉素过敏', category: 'fact', importance: 5, sourceType: 'patient', patientHash: 'patient_a' })
    facts.add({ content: '医生偏好先看CT再定方案', category: 'preference', importance: 4, sourceType: 'doctor' })
    facts.commit()

    const persona = buildPersona(facts, knowledge)

    expect(persona).toContain('先看CT再定方案')
    expect(persona).not.toContain('青霉素过敏')
  })

  test('#4 排序：高重要性新近 fact 优先于陈旧低价值', () => {
    const facts = new FactsStore(baseDir)
    const knowledge = new KnowledgeStore(baseDir)
    // 陈旧高价值（10 天前）
    const oldHigh = facts.add({ content: '旧的但重要的事实', category: 'fact', importance: 5, sourceType: 'doctor' })
    // 新近中价值（1 小时前）
    const freshMid = facts.add({ content: '新近中等重要的事实', category: 'fact', importance: 3, sourceType: 'doctor' })
    facts.commit()
    // 调整时间戳
    const now = Date.now()
    const rows = facts.all()
    const oldRow = rows.find(f => f.id === oldHigh.id)
    const freshRow = rows.find(f => f.id === freshMid.id)
    if (oldRow) oldRow.lastSeenAt = now - 10 * 86400_000
    if (freshRow) freshRow.lastSeenAt = now - 3600_000
    facts.commit()

    const persona = buildPersona(facts, knowledge)
    const topFactsSection = persona.slice(persona.indexOf('Key clinical facts'))
    // 排序后新近中价值应排在陈旧高价值之前（recency 主导 3 天后的衰减）
    expect(topFactsSection.indexOf('新近中等重要的事实')).toBeLessThan(topFactsSection.indexOf('旧的但重要的事实'))
  })
})
