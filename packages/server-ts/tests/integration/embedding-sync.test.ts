import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { EventLog } from '../../src/core/event-log.js'
import { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../../src/evolution/stores.js'
import { MemoryService } from '../../src/memory/memory.service.js'
import { MemoryGraphGateway } from '../../src/memory/memory-gateway.js'
import type { FactNode } from '../../src/memory/memory.types.js'

vi.mock('../../src/common/llm.js', () => ({
  deepseekChat: vi.fn(),
  deepseekStream: vi.fn(),
  getApiKey: () => 'test-key',
  setLlmTelemetryService: vi.fn(),
  DEEPSEEK_CHAT_MODEL: 'deepseek-v4-flash',
  DEEPSEEK_PREMIUM_MODEL: 'deepseek-v4-pro',
}))

/**
 * #255: fully isolated per-test stores — the previous version depended on
 * the module-level getUserContext(userId) cache + manual TWIN_BASE_DIR
 * mutation, which raced with other test files during the full run.
 */
let baseDir: string
let userId: string

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-sync-'))
  userId = `user_${Math.random().toString(36).slice(2, 8)}`
  vi.stubEnv('TWIN_BASE_DIR', baseDir)
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  fs.rmSync(baseDir, { recursive: true, force: true })
})

function makeGateway() {
  const eventLog = new EventLog(baseDir, userId)
  const facts = new FactsStore(baseDir)
  const knowledge = new KnowledgeStore(baseDir)
  const memory = new MemoryService({ eventLog, baseDir, legacyFacts: facts, legacyKnowledge: knowledge, ownerId: userId })
  const gateway = new MemoryGraphGateway(userId, memory, facts, new EpisodesStore(baseDir), new SkillsStore(baseDir), knowledge)
  return { memory, gateway, facts }
}

function vec(n: number): number[] {
  const v = new Array(384).fill(0)
  v[n] = 1
  return v
}

describe('#183 embedding index sync (retrieve never surfaces superseded) — isolated (#255)', () => {
  test('superseded fact is filtered from retrieval', async () => {
    const { memory, gateway } = makeGateway()
    const index = (gateway as any).embeddingIndex()

    const fact = memory.addFact({ content: '患者对青霉素过敏', category: 'allergy', importance: 5, sourceType: 'doctor' }, 'system') as FactNode
    index.upsert({
      nodeId: fact.id, stableId: fact.stableId, type: 'fact', patientHash: undefined,
      contentHash: fact.content, vector: vec(1), model: 'test', norm: 1, updatedAt: Date.now(),
    })

    // mock embedding so retrieve can query
    ;(gateway as any).embedOrNull = async () => vec(1)

    const hits = await gateway.retrieve('过敏', {})
    expect(hits.some((h) => h.stableId === fact.stableId)).toBe(true)

    memory.deleteFact(fact.stableId, 'user')
    const hitsAfter = await gateway.retrieve('过敏', {})
    expect(hitsAfter.some((h) => h.stableId === fact.stableId)).toBe(false)
  }, 30000)

  test('edited fact retrieval returns the NEW content', async () => {
    const { memory, gateway } = makeGateway()
    const index = (gateway as any).embeddingIndex()

    const fact = memory.addFact({ content: '白细胞 11.2 偏高', category: 'exam', importance: 3, sourceType: 'doctor' }, 'system') as FactNode
    index.upsert({
      nodeId: fact.id, stableId: fact.stableId, type: 'fact', patientHash: undefined,
      contentHash: fact.content, vector: vec(2), model: 'test', norm: 1, updatedAt: Date.now(),
    })
    ;(gateway as any).embedOrNull = async () => vec(2)

    memory.editFact(fact.stableId, { content: '白细胞 9.8 正常' }, 'user')

    const hits = await gateway.retrieve('白细胞', {})
    const hit = hits.find((h) => h.stableId === fact.stableId)
    expect(hit).toBeDefined()
    expect(hit!.content).toContain('9.8')
    expect(hit!.content).not.toContain('11.2')
  }, 30000)
})
