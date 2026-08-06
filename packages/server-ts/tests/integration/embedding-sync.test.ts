import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { getAuthUserId } from '../setup.js'
import { getUserContext } from '../../src/modules/chat/user-context.js'
import { MemoryGraphGateway } from '../../src/memory/memory-gateway.js'
import { EmbeddingIndex } from '../../src/memory/embedding-index.js'
import type { FactNode } from '../../src/memory/memory.types.js'

vi.mock('../../src/common/llm.js', () => ({
  deepseekChat: vi.fn(),
  deepseekStream: vi.fn(),
  getApiKey: () => 'test-key',
  setLlmTelemetryService: vi.fn(),
  DEEPSEEK_CHAT_MODEL: 'deepseek-v4-flash',
  DEEPSEEK_PREMIUM_MODEL: 'deepseek-v4-pro',
}))

beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', 'test-key') })
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

function vec(n: number): number[] {
  const v = new Array(384).fill(0)
  v[n] = 1
  return v
}

describe('#183 embedding index sync (retrieve never surfaces superseded)', () => {
  test('superseded fact is filtered from retrieval', async () => {
    const userId = await getAuthUserId()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-sync-'))
    process.env.TWIN_BASE_DIR = tmp

    const ctx = getUserContext(userId)
    const gateway = new MemoryGraphGateway(userId, ctx.memory, ctx.facts, ctx.episodes, ctx.skills, ctx.knowledge)
    const index = (gateway as any).embeddingIndex() as EmbeddingIndex

    // Fact approved → indexed
    const fact = ctx.memory.addFact({ content: '患者对青霉素过敏', category: 'allergy', importance: 5, sourceType: 'doctor' }, 'system') as FactNode
    index.upsert({
      nodeId: fact.id, stableId: fact.stableId, type: 'fact', patientHash: undefined,
      contentHash: fact.content, vector: vec(1), model: 'test', norm: 1, updatedAt: Date.now(),
    })

    // mock embedding so retrieve can query
    ;(gateway as any).embedOrNull = async () => vec(1)

    const hits = await gateway.retrieve('过敏', {})
    expect(hits.some((h) => h.stableId === fact.stableId)).toBe(true)

    // Supersede the fact (edit/delete) → retrieval must drop it
    ctx.memory.deleteFact(fact.stableId, 'user')
    const hitsAfter = await gateway.retrieve('过敏', {})
    expect(hitsAfter.some((h) => h.stableId === fact.stableId)).toBe(false)
  }, 30000)

  test('edited fact retrieval returns the NEW content', async () => {
    const userId = await getAuthUserId()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-sync2-'))
    process.env.TWIN_BASE_DIR = tmp

    const ctx = getUserContext(userId)
    const gateway = new MemoryGraphGateway(userId, ctx.memory, ctx.facts, ctx.episodes, ctx.skills, ctx.knowledge)
    const index = (gateway as any).embeddingIndex() as EmbeddingIndex

    const fact = ctx.memory.addFact({ content: '白细胞 11.2 偏高', category: 'exam', importance: 3, sourceType: 'doctor' }, 'system') as FactNode
    index.upsert({
      nodeId: fact.id, stableId: fact.stableId, type: 'fact', patientHash: undefined,
      contentHash: fact.content, vector: vec(2), model: 'test', norm: 1, updatedAt: Date.now(),
    })
    ;(gateway as any).embedOrNull = async () => vec(2)

    ctx.memory.editFact(fact.stableId, { content: '白细胞 9.8 正常' }, 'user')

    const hits = await gateway.retrieve('白细胞', {})
    const hit = hits.find((h) => h.stableId === fact.stableId)
    expect(hit).toBeDefined()
    expect(hit!.content).toContain('9.8')
    expect(hit!.content).not.toContain('11.2')
  }, 30000)

  afterEach(() => { delete process.env.TWIN_BASE_DIR })
})
