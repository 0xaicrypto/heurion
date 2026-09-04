import { describe, test, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { EventLog } from '../../src/core/event-log.js'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores.js'
import { MemoryService } from '../../src/memory/memory.service.js'

describe('curation propagation persists across reload', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curation-persist-'))
  })

  function makeMemory() {
    const eventLog = new EventLog(baseDir, 'user_1')
    const facts = new FactsStore(baseDir)
    const knowledge = new KnowledgeStore(baseDir)
    return new MemoryService({
      eventLog, baseDir, legacyFacts: facts, legacyKnowledge: knowledge, ownerId: 'user_1',
    })
  }

  test('summary stays stale after a reload (edit → propagate → single commit)', () => {
    const m1 = makeMemory()
    const fact = m1.addFact({ content: '患者白细胞升高', category: 'exam', importance: 4, sourceType: 'doctor' }, 'system') as any
    const summary = m1.addSummary({
      title: '感染指标文章',
      content: '基于白细胞数据的文章',
      provenance: { sourceKind: 'proposal', sourceRef: 'p1' },
      sourceFactStableIds: [fact.stableId],
    }, 'system') as any
    expect((summary as any).status ?? 'current').toBe('current')

    // Edit the fact → dependent summary must become stale
    m1.editFact(fact.stableId, { content: '患者白细胞正常' }, 'user')
    const inMem = m1.graph.getLatestByStableId(summary.stableId) as any
    expect(inMem.status).toBe('stale')

    // Reload from disk (simulates a restart)
    const m2 = makeMemory()
    const reloadedSummary = m2.graph.getLatestByStableId(summary.stableId) as any
    expect(reloadedSummary.status).toBe('stale')
  }, 30000)
})
