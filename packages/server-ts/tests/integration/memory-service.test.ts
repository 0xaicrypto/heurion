import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import { EventLog } from '../../src/core/event-log.js'
import { FactsStore, KnowledgeStore } from '../../src/evolution/stores.js'
import { MemoryService } from '../../src/memory/memory.service.js'

describe('MemoryService', () => {
  const baseDir = '/tmp/test-memory-service'

  function setup(userId = 'user_1') {
    fs.rmSync(baseDir, { recursive: true, force: true })
    fs.mkdirSync(baseDir, { recursive: true })
    const eventLog = new EventLog(baseDir, userId)
    const facts = new FactsStore(baseDir)
    const knowledge = new KnowledgeStore(baseDir)
    const memory = new MemoryService({
      eventLog,
      baseDir,
      legacyFacts: facts,
      legacyKnowledge: knowledge,
      ownerId: userId,
    })
    return { eventLog, facts, knowledge, memory }
  }

  beforeEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true })
  })

  it('adds a fact and writes to legacy store', () => {
    const { memory, facts } = setup()
    const fact = memory.addFact({ content: 'ZL has EGFR exon19del', category: 'fact', importance: 5 })

    expect(fact.stableId).toBeDefined()
    expect(fact.version).toBe(1)
    expect(fact.status).toBe('current')

    const legacy = facts.all()
    expect(legacy).toHaveLength(1)
    expect(legacy[0].id).toBe(fact.stableId)
    expect(legacy[0].content).toBe('ZL has EGFR exon19del')
  })

  it('versions a fact on edit and keeps old version superseded', () => {
    const { memory } = setup()
    const fact = memory.addFact({ content: 'ZL has EGFR exon19del', importance: 5 })
    const edited = memory.editFact(fact.stableId, { content: 'ZL has EGFR exon19del (confirmed)' })

    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    expect(edited.value.version).toBe(2)
    expect(edited.value.content).toBe('ZL has EGFR exon19del (confirmed)')

    const versions = memory.graph.getVersions(fact.stableId)
    expect(versions).toHaveLength(2)
    expect(versions[0].status).toBe('current')
    expect(versions[1].status).toBe('superseded')
  })

  it('marks dependent articles stale when a fact is edited', () => {
    const { memory, knowledge } = setup()
    const fact = memory.addFact({ content: 'ZL has EGFR exon19del', importance: 5 })
    const article = memory.addArticle({
      title: 'ZL EGFR status',
      content: 'ZL has EGFR mutation.',
      sourceFactNodeIds: [fact.id],
    })

    expect(article.status).toBe('current')

    memory.editFact(fact.stableId, { content: 'ZL has EGFR L858R' })

    const latestArticle = memory.graph.getLatestByStableId(article.stableId) as any
    expect(latestArticle.status).toBe('stale')
    expect(latestArticle.staleBecause).toContain(fact.stableId)

    const legacyArticle = knowledge.all().find(a => a.id === article.stableId)
    expect(legacyArticle?.status).toBe('stale')
  })

  it('supersedes an article when its only source fact is deleted', () => {
    const { memory } = setup()
    const fact = memory.addFact({ content: 'ZL has EGFR exon19del', importance: 5 })
    const article = memory.addArticle({
      title: 'ZL EGFR status',
      content: 'ZL has EGFR mutation.',
      sourceFactNodeIds: [fact.id],
    })

    memory.deleteFact(fact.stableId)

    const latestArticle = memory.graph.getLatestByStableId(article.stableId) as any
    expect(latestArticle.status).toBe('superseded')
  })

  it('supersedes article when too many source facts are deleted', () => {
    const { memory } = setup()
    const fact = memory.addFact({ content: 'ZL has EGFR exon19del', importance: 5 })
    const article = memory.addArticle({
      title: 'ZL EGFR status',
      content: 'ZL has EGFR mutation.',
      sourceFactNodeIds: [fact.id],
    })

    memory.deleteFact(fact.stableId)

    const latestArticle = memory.graph.getLatestByStableId(article.stableId) as any
    expect(latestArticle.status).toBe('superseded')
  })

  it('propagates document deletion to derived facts and dependent articles', () => {
    const { memory } = setup()
    const doc = memory.addDocument({
      fileId: 'file_001',
      sha256: 'abc123',
      name: 'CT_report.pdf',
      mimeType: 'application/pdf',
    })
    const fact = memory.addFact({ content: 'ZL RUL nodule 18mm', sourceType: 'document', provenance: { sourceKind: 'document', sourceRef: 'file_001' } })
    memory.graph.addRelation({
      id: 'rel_001',
      sourceId: doc.id,
      targetId: fact.id,
      relation: 'derives_from',
      createdAt: Date.now(),
    })
    memory.graph.commit()

    const article = memory.addArticle({
      title: 'ZL RUL nodule',
      content: 'RUL nodule 18mm.',
      sourceFactNodeIds: [fact.id],
    })

    memory.deleteDocument('file_001')

    const latestFact = memory.graph.getLatestByStableId(fact.stableId) as any
    expect(latestFact.status).toBe('superseded')

    const latestArticle = memory.graph.getLatestByStableId(article.stableId) as any
    expect(latestArticle.status).toBe('superseded')
  })

  it('re-opens a gap when its answering fact is deleted', async () => {
    const { memory } = setup()
    const gap = memory.addGap({ query: 'What is ZL EGFR status?', source: 'user' })
    const fact = memory.addFact({ content: 'ZL EGFR exon19del', importance: 5 })
    memory.answerGap(gap.stableId, fact)

    let latestGap = memory.graph.getLatestByStableId(gap.stableId) as any
    expect(latestGap.answerNodeId).toBe(fact.stableId)

    memory.deleteFact(fact.stableId)

    latestGap = memory.graph.getLatestByStableId(gap.stableId) as any
    expect(latestGap.status).toBe('current')
  })

  it('persists graph state across reload', () => {
    const { memory } = setup()
    const fact = memory.addFact({ content: 'ZL EGFR exon19del', importance: 5 })
    const firstVersion = memory.graph.currentVersion()

    // Reload
    const eventLog2 = new EventLog(baseDir, 'user_1')
    const facts2 = new FactsStore(baseDir)
    const knowledge2 = new KnowledgeStore(baseDir)
    const memory2 = new MemoryService({
      eventLog: eventLog2,
      baseDir,
      legacyFacts: facts2,
      legacyKnowledge: knowledge2,
      ownerId: 'user_1',
    })

    expect(memory2.graph.nodeCount).toBeGreaterThan(0)
    expect(memory2.graph.getLatestByStableId(fact.stableId)).toBeDefined()
    expect(memory2.graph.currentVersion()).toBe(firstVersion)
  })
})
