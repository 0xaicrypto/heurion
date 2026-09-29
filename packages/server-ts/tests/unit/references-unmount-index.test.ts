import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * #1146 — 取消引用后的语义索引清理接线：
 * `removeReferenceIndex` 此前从未被调用（删引用不清理 embedding，检索/建议
 * 仍命中幽灵条目）。修复：该 item 不被任何会话（含 doc- legacy 回退表）
 * 挂载时清理索引；本体保留（设计红线）。
 */
const mocks = vi.hoisted(() => ({
  listSessionReferences: vi.fn(),
  removeSessionReference: vi.fn(),
  removeReferenceIndex: vi.fn(),
  indexReferenceItem: vi.fn(),
  sessionRefCount: vi.fn(),
  docRefCount: vi.fn(),
  demote: vi.fn(),
}))

vi.mock('../../src/common/auth.guard.js', () => ({ authGuard: async () => {} }))
vi.mock('../../src/common/logger.js', () => ({ makeLogger: () => new Proxy({}, { get: () => vi.fn() }) }))
vi.mock('../../src/lib/reference-store.js', () => ({
  addSessionReference: vi.fn(),
  listSessionReferences: mocks.listSessionReferences,
  loadSessionReferenceItems: vi.fn(async () => []),
  removeSessionReference: mocks.removeSessionReference,
  resolveFileSourceRef: vi.fn(),
  normalizeLegacyRefType: (k: string) => k,
  legacyRefToItemInput: vi.fn(),
  writeThroughLegacyRef: vi.fn(),
}))
vi.mock('../../src/modules/shared/summary-lookup.js', () => ({ classifyGuidelineBySummaryTitle: vi.fn() }))
vi.mock('../../src/memory/reference-embedding.js', () => ({
  indexReferenceItem: mocks.indexReferenceItem,
  removeReferenceIndex: mocks.removeReferenceIndex,
}))
vi.mock('../../src/modules/shared/suggested-reference.service.js', () => ({
  detectOpeningSuggestions: vi.fn(async () => []),
  listPendingSuggestions: vi.fn(async () => []),
  resolveSuggestedReference: vi.fn(),
}))
vi.mock('../../src/memory/memory-usage-bus.js', () => ({ recordMemoryUsage: vi.fn() }))
vi.mock('../../src/memory/memory-tier-store.js', () => ({
  ReferenceTierStore: class {
    demote(...args: unknown[]) { return mocks.demote(...args) }
  },
}))
vi.mock('../../src/common/prisma.js', () => ({
  default: {
    sessionReference: { count: mocks.sessionRefCount },
    docReference: { count: mocks.docRefCount },
  },
}))
vi.mock('../../src/common/ownership.js', () => ({ findOwned: vi.fn() }))
vi.mock('../../src/retrieval/text-overlap.js', () => ({ extractKeywords: () => [], overlapScore: () => 0 }))
vi.mock('../../src/modules/shared/doc-reference-effects.js', () => ({ runDocReferenceEffects: vi.fn() }))

import { referencesRouter } from '../../src/modules/references/references.router.js'

function makeHarness() {
  const routes = new Map<string, (req: unknown, reply: unknown) => Promise<unknown>>()
  const app = {
    addHook: vi.fn(),
    get: (p: string, h: (req: unknown, reply: unknown) => Promise<unknown>) => routes.set(`GET ${p}`, h),
    post: (p: string, h: (req: unknown, reply: unknown) => Promise<unknown>) => routes.set(`POST ${p}`, h),
    delete: (p: string, h: (req: unknown, reply: unknown) => Promise<unknown>) => routes.set(`DELETE ${p}`, h),
  }
  return { routes, app: app as never }
}

const makeReply = () => ({ status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() }) as never

async function callDelete(sessionId: string) {
  const { routes, app } = makeHarness()
  await referencesRouter(app as never)
  const handler = routes.get('DELETE /api/v1/sessions/:sessionId/references/:referenceId')!
  return handler(
    { params: { sessionId, referenceId: 'ref_1' }, user: { userId: 'u1' }, headers: {} },
    makeReply(),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listSessionReferences.mockResolvedValue([{ referenceId: 'ref_1' }])
  mocks.removeSessionReference.mockResolvedValue(true)
  mocks.demote.mockResolvedValue(undefined)
  mocks.sessionRefCount.mockResolvedValue(0)
  mocks.docRefCount.mockResolvedValue(0)
})

describe('#1146 取消引用清理语义索引', () => {
  test('已无任何会话挂载 → removeReferenceIndex 被调用', async () => {
    await callDelete('chat-session-1')
    expect(mocks.removeSessionReference).toHaveBeenCalledWith('u1', 'chat-session-1', 'ref_1')
    expect(mocks.removeReferenceIndex).toHaveBeenCalledWith('u1', 'ref_1')
  })

  test('仍挂载于其他会话 → 不清理（其他会话仍在用）', async () => {
    mocks.sessionRefCount.mockResolvedValue(1)
    await callDelete('chat-session-1')
    expect(mocks.removeReferenceIndex).not.toHaveBeenCalled()
  })

  test('doc- 会话 legacy 回退表仍有行 → 保守不清理', async () => {
    mocks.docRefCount.mockResolvedValue(1)
    await callDelete('doc-1234567890abcdef')
    expect(mocks.docRefCount).toHaveBeenCalledWith({ where: { userId: 'u1', docId: '1234567890abcdef' } })
    expect(mocks.removeReferenceIndex).not.toHaveBeenCalled()
  })
})
