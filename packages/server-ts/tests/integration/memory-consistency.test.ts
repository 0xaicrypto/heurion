import { describe, test, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { EventLog } from '../../src/core/event-log.js'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores.js'
import { MemoryService } from '../../src/memory/memory.service.js'

/**
 * §8.2-4 — memory consistency regression lock (#215).
 * Scenarios 1/2/4/5 have dedicated suites:
 *   curation-persist.test.ts (restart), embedding-sync.test.ts (retrieval),
 *   cursor-cross-session.test.ts (interleaved sessions),
 *   gap-coverage.test.ts (quick-scan binding).
 * Scenario 3 (dual-store write atomicity) lives here — see #192.
 */

describe('memory consistency', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-consistency-'))
  })

  function makeMemory() {
    const eventLog = new EventLog(baseDir, 'user_1')
    const facts = new FactsStore(baseDir)
    const knowledge = new KnowledgeStore(baseDir)
    return new MemoryService({
      eventLog, baseDir, legacyFacts: facts, legacyKnowledge: knowledge, ownerId: 'user_1',
    })
  }

  test('scenario 3: graph commit failure after legacy commit must not leave divergent views (#192)', () => {
    const m1 = makeMemory()
    const fact = m1.addFact({ content: '患者发热', category: 'symptom', importance: 3, sourceType: 'doctor' }, 'system') as any

    // Legacy store commits FIRST (line 190), then graph commits (line 196).
    // Simulate the graph disk write failing — legacy already on disk with new content.
    const graphCommitSpy = vi.spyOn(m1['graph'], 'commit')
    graphCommitSpy.mockImplementationOnce(() => { throw new Error('graph disk full') })

    expect(() => m1.editFact(fact.stableId, { content: '患者发热已退' }, 'user')).toThrow('graph disk full')
    expect(graphCommitSpy).toHaveBeenCalled()

    // Reload both stores from disk (simulated restart).
    // Dual-store atomicity (#192): the two views MUST agree — both old or both new.
    const m2 = makeMemory()
    const graphLatest = m2.graph.getLatestByStableId(fact.stableId) as any
    const legacyAll = m2['legacyFacts'].all()
    const legacyContent = legacyAll.find((f: any) => f.id === fact.stableId)?.content

    expect(legacyContent === graphLatest.content).toBe(true)
  }, 30000)

  test('scenario 3b: addFact graph failure rolls back the provisional legacy write (#192)', () => {
    const m1 = makeMemory()
    const graphCommitSpy = vi.spyOn(m1['graph'], 'commit')
    graphCommitSpy.mockImplementationOnce(() => { throw new Error('graph disk full') })

    expect(() => m1.addFact({ content: '患者血压 140/90', category: 'vital', importance: 4, sourceType: 'doctor' }, 'system')).toThrow('graph disk full')

    const m2 = makeMemory()
    const graphFacts = m2.graph.getCurrentNodesByType('fact') as any[]
    const legacyFacts = m2['legacyFacts'].all()
    // Neither view may contain the half-written fact.
    expect(graphFacts.some((f: any) => f.content.includes('血压 140/90'))).toBe(false)
    expect(legacyFacts.some((f: any) => f.content.includes('血压 140/90'))).toBe(false)
  }, 30000)

  test('scenario 3c: addArticle graph failure rolls back the provisional legacy write (#192)', () => {
    const m1 = makeMemory()
    const fact = m1.addFact({ content: '患者白细胞升高', category: 'exam', importance: 4, sourceType: 'doctor' }, 'system') as any
    const graphCommitSpy = vi.spyOn(m1['graph'], 'commit')
    graphCommitSpy.mockImplementationOnce(() => { throw new Error('graph disk full') })

    expect(() => m1.addArticle({
      title: '感染指标文章',
      content: '基于白细胞数据的文章',
      provenance: { sourceKind: 'proposal', sourceRef: 'p1' },
      sourceFactStableIds: [fact.stableId],
    }, 'system')).toThrow('graph disk full')

    const m2 = makeMemory()
    const graphArticles = m2.graph.getCurrentNodesByType('article') as any[]
    const legacyArticles = m2['legacyKnowledge'].all()
    expect(graphArticles.some((a: any) => a.title === '感染指标文章')).toBe(false)
    expect(legacyArticles.some((a: any) => a.title === '感染指标文章')).toBe(false)
  }, 30000)

  test('scenario 3d: supersedeFact graph failure keeps the fact current in both views (#192)', () => {
    const m1 = makeMemory()
    const fact = m1.addFact({ content: '患者发热', category: 'symptom', importance: 3, sourceType: 'doctor' }, 'system') as any
    const graphCommitSpy = vi.spyOn(m1['graph'], 'commit')
    graphCommitSpy.mockImplementationOnce(() => { throw new Error('graph disk full') })

    expect(() => m1.supersedeFact(fact.stableId, 'test')).toThrow('graph disk full')

    const m2 = makeMemory()
    const graphLatest = m2.graph.getLatestByStableId(fact.stableId) as any
    const legacyFacts = m2['legacyFacts'].all()
    expect(graphLatest.status).toBe('current')
    expect(legacyFacts.some((f: any) => f.id === fact.stableId)).toBe(true)
  }, 30000)

  test('scenario 3e: reconcileLegacy repairs a legacy divergence from the graph (#192)', () => {
    const m1 = makeMemory()
    m1.addFact({ content: '患者发热', category: 'symptom', importance: 3, sourceType: 'doctor' }, 'system')
    m1.addFact({ content: '患者血压 120/80', category: 'vital', importance: 4, sourceType: 'doctor' }, 'system')

    // Manufacture a divergence: legacy content diverges from the graph,
    // plus a ghost fact that only exists in legacy.
    m1['legacyFacts'].updateWhere((f: any) => f.content.includes('发热'), { content: '患者发热已退' })
    m1['legacyFacts'].add({
      category: 'symptom', importance: 1, content: 'ghost fact', sourceType: 'general' as any,
      patientHash: undefined, studyId: undefined, ttl: undefined,
    })
    m1['legacyFacts'].commit()

    expect(m1.reconcileLegacy().repaired).toBe(true)

    const m2 = makeMemory()
    const legacyFacts = m2['legacyFacts'].all()
    expect(legacyFacts.some((f: any) => f.content === 'ghost fact')).toBe(false)
    expect(legacyFacts.some((f: any) => f.content === '患者发热已退')).toBe(false)
    expect(legacyFacts.some((f: any) => f.content === '患者发热')).toBe(true)
  }, 30000)

  test('scenario 3f: reconcileLegacy no-ops when both stores agree (#192)', () => {
    const m1 = makeMemory()
    m1.addFact({ content: '患者发热', category: 'symptom', importance: 3, sourceType: 'doctor' }, 'system')
    expect(m1.reconcileLegacy().repaired).toBe(false)
  }, 30000)
})
