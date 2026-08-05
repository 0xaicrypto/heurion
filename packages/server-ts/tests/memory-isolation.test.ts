import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from './helpers/ai-mock.js'
import { getApp, authHeader } from './setup.js'
import { getUserContext } from '../src/modules/chat/user-context.js'
import { MemoryGraphGateway } from '../src/memory/memory-gateway.js'

vi.mock('../src/common/llm.js', () => mockAiProvider())

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

async function registerUser(app: any, prefix: string): Promise<{ token: string; userId: string }> {
  const username = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ username, password: 'test123456', display_name: username }),
  })
  const body = JSON.parse(res.payload)
  const payload = JSON.parse(Buffer.from(body.jwt_token.split('.')[1], 'base64').toString())
  return { token: body.jwt_token, userId: payload.userId }
}

function gwFor(userId: string): MemoryGraphGateway {
  const ctx = getUserContext(userId)
  return new MemoryGraphGateway(userId, ctx.memory, ctx.facts, ctx.episodes, ctx.skills, ctx.knowledge)
}

describe('memory per-user isolation', () => {
  test('facts written by user A are not visible to user B (stores + graph)', async () => {
    const app = await getApp()
    const a = await registerUser(app, 'iso_a')
    const b = await registerUser(app, 'iso_b')

    // A proposes + approves a fact → written into A's graph/stores
    const gwa = gwFor(a.userId)
    const pa = await gwa.propose({ scopeType: 'global', kind: 'fact', content: 'A 的独家事实：患者对阿司匹林过敏', importance: 5 })
    await gwa.applyApproved(pa)

    const ctxA = getUserContext(a.userId)
    const ctxB = getUserContext(b.userId)

    // A's store has it
    expect(ctxA.facts.all().some((f) => f.content.includes('阿司匹林'))).toBe(true)
    expect(ctxA.memory.graph.getAllNodes().some((n: any) => n.content?.includes('阿司匹林'))).toBe(true)

    // B's store/graph does NOT
    expect(ctxB.facts.all().some((f) => f.content.includes('阿司匹林'))).toBe(false)
    expect(ctxB.memory.graph.getAllNodes().some((n: any) => n.content?.includes('阿司匹林'))).toBe(false)

    // B's own write lands only in B's storage
    const gwb = gwFor(b.userId)
    const pb = await gwb.propose({ scopeType: 'global', kind: 'fact', content: 'B 的独家事实：患者对头孢过敏', importance: 4 })
    await gwb.applyApproved(pb)

    expect(ctxB.facts.all().some((f) => f.content.includes('头孢'))).toBe(true)
    expect(ctxA.facts.all().some((f) => f.content.includes('头孢'))).toBe(false)
  }, 30000)

  test('proposal records carry the owning userId and are scoped in lists', async () => {
    const app = await getApp()
    const a = await registerUser(app, 'scope_a')
    const b = await registerUser(app, 'scope_b')

    const gwa = gwFor(a.userId)
    const gwb = gwFor(b.userId)
    await gwa.propose({ scopeType: 'global', kind: 'fact', content: 'A 待审事实' })
    await gwb.propose({ scopeType: 'global', kind: 'fact', content: 'B 待审事实' })

    const pendingA = await gwa.listPending({ global: true })
    const pendingB = await gwb.listPending({ global: true })

    expect(pendingA.every((p) => p.userId === a.userId)).toBe(true)
    expect(pendingB.every((p) => p.userId === b.userId)).toBe(true)
    expect(pendingA.some((p) => p.content.includes('B 待审事实'))).toBe(false)
    expect(pendingB.some((p) => p.content.includes('A 待审事实'))).toBe(false)
  }, 30000)

  test('embedding index is per-user', async () => {
    const app = await getApp()
    const a = await registerUser(app, 'emb_a')
    const b = await registerUser(app, 'emb_b')
    const { EmbeddingIndex } = await import('../src/memory/embedding-index.js')
    const path = await import('path')

    const idxA = new EmbeddingIndex(path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', a.userId))
    const idxB = new EmbeddingIndex(path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', b.userId))

    idxA.upsert({ nodeId: 'n1', stableId: 'f1', type: 'fact', contentHash: 'h', vector: [1, 0], model: 'm', norm: 1, updatedAt: 0 })
    expect(idxA.count()).toBe(1)
    expect(idxB.count()).toBe(0)
  })
})
