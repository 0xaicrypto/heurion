import { describe, test, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { EventLog } from '../src/core/event-log.js'
import { FactsStore, KnowledgeStore } from '../src/evolution/stores.js'
import { MemoryService } from '../src/memory/memory.service.js'

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
})
