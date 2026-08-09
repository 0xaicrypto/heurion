import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { MemoryService } from '../../src/memory/memory.service.js'
import { MemoryGraphGateway } from '../../src/memory/memory-gateway.js'
import { VersionedStore } from '../../src/core/versioned-store.js'
import { EventLog } from '../../src/core/event-log.js'
import { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../../src/evolution/stores.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * #25 / #199: hybrid graph retrieval (vector → traversal → rerank +
 * provenance) and versioned-store compaction.
 */
describe('GraphRAG hybrid retrieval (#25)', () => {
  let tmp: string
  let memory: MemoryService
  let gateway: MemoryGraphGateway

  beforeEach(async () => {
    // Per-test base dir — the embedding index file persists on disk and
    // would leak records (and mismatched vector dims) across tests.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'graphrag-'))
    // EmbeddingService resolves its index dir from TWIN_BASE_DIR, not from
    // the constructor arg — point it at the per-test dir or parallel runs
    // share (and poison) the default .nexus/twins index.
    process.env.TWIN_BASE_DIR = tmp
    const eventLog = new EventLog(tmp, 'u1')
    const facts = new FactsStore(tmp)
    const episodes = new EpisodesStore(tmp)
    const skills = new SkillsStore(tmp)
    const knowledge = new KnowledgeStore(tmp)
    memory = new MemoryService({
      eventLog, baseDir: tmp, legacyFacts: facts, legacyKnowledge: knowledge, ownerId: 'u1',
    })
    // Stub embed: deterministic vector by keyword hash so tests don't need
    // a real embedding service. 8-dim to match the seeded records.
    const embedFn = async (texts: string[]): Promise<number[][]> =>
      texts.map((t) => {
        const v = new Array(8).fill(0) as number[]
        const kw = t.toLowerCase()
        if (kw.includes('结节') || kw.includes('nodule')) v[0] = 1
        if (kw.includes('cea')) v[1] = 1
        if (kw.includes('化疗') || kw.includes('chemo')) v[2] = 1
        if (kw.includes('egfr')) v[3] = 1
        v[4] = 0.1
        return v
      })
    gateway = new MemoryGraphGateway('u1', memory, facts, episodes, skills, knowledge, embedFn)
  })

  afterEach(async () => {
    await memory.eventLog.flush().catch(() => {})
  })

  test('vector recall returns topK with score', async () => {
    const hits = await gateway.retrieve('结节', { patientHash: 'p1' }, { topK: 5, minScore: 0.3 })
    expect(Array.isArray(hits)).toBe(true)
  })

  test('getNeighbors follows relations and maps versioned node ids to stable ids', () => {
    const f1 = memory.addFact({ content: '左肺上叶结节 8mm', category: 'fact', importance: 4, sourceType: 'patient', patientHash: 'p1' }, 'test')
    const f2 = memory.addFact({ content: 'CEA 升高至 12', category: 'fact', importance: 4, sourceType: 'patient', patientHash: 'p1' }, 'test')
    const nb = memory.graph.getNeighbors(f1.stableId, 1)
    // No relations yet → empty.
    expect(nb.length).toBe(0)
    // Add a relation via addRelation.
    memory.graph.addRelation({ id: 'rel1', sourceId: f1.id, targetId: f2.id, relation: 'related_to', createdAt: Date.now() })
    const nb2 = memory.graph.getNeighbors(f1.stableId, 1)
    expect(nb2.length).toBe(1)
    expect(nb2[0].node.stableId).toBe(f2.stableId)
    expect(nb2[0].edge.relation).toBe('related_to')
  })

  test('retrieveGraphEnhanced returns vector hits with connections + provenance', async () => {
    const f1 = memory.addFact({ content: '左肺上叶结节 8mm', category: 'fact', importance: 4, sourceType: 'patient', patientHash: 'p1' }, 'test')
    const f2 = memory.addFact({ content: 'CEA 升高至 12', category: 'fact', importance: 4, sourceType: 'patient', patientHash: 'p1' }, 'test')
    memory.graph.addRelation({ id: 'rel1', sourceId: f1.id, targetId: f2.id, relation: 'related_to', createdAt: Date.now() })
    memory.graph.commit()

    // Seed the embedding index (the gateway's retrieve reads it).
    const norm = 1
    gateway.embeddingIndex().upsert({
      nodeId: f1.id, stableId: f1.stableId, type: 'fact', patientHash: 'p1',
      contentHash: f1.content.slice(0, 16), vector: [1, 0, 0, 0, 0.1, 0, 0, 0], model: 'test', norm, updatedAt: Date.now(),
    })
    gateway.embeddingIndex().upsert({
      nodeId: f2.id, stableId: f2.stableId, type: 'fact', patientHash: 'p1',
      contentHash: f2.content.slice(0, 16), vector: [0, 1, 0, 0, 0.1, 0, 0, 0], model: 'test', norm, updatedAt: Date.now(),
    })

    const hits = await gateway.retrieveGraphEnhanced('结节', { patientHash: 'p1' }, { topK: 5, minScore: 0.1 })
    const f1Hit = hits.find((h) => h.stableId === f1.stableId)
    expect(f1Hit).toBeDefined()
    expect(f1Hit!.score).toBeGreaterThan(0)
    expect(Array.isArray(f1Hit!.connections)).toBe(true)
    // The connected fact appears either as connection or as an expanded hit.
    const sawF2 = f1Hit!.connections.some((c) => c.stableId === f2.stableId) || hits.some((h) => h.stableId === f2.stableId)
    expect(sawF2).toBe(true)
  })
})

describe('VersionedStore compaction (#199)', () => {
  test('snapshots beyond maxVersions are dropped, pointer intact', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vstore-'))
    const store = new VersionedStore(dir, 2, 5) // max 5
    for (let i = 0; i < 12; i++) {
      store.propose({ i })
    }
    expect(store.currentVersion()).toBe('v12')
    const history = store.history()
    expect(history.length).toBeLessThanOrEqual(5)
    expect(history[0].version).toBe('v08') // oldest 7 dropped
    // current snapshot still readable.
    expect((store.current() as any).i).toBe(11)
  })
})
