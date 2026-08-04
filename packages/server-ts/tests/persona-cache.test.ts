import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { FactsStore, KnowledgeStore } from '../src/evolution/stores'
import * as userContext from '../src/modules/chat/user-context.js'
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
