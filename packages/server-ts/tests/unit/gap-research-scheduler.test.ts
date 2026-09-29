import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * #1143 — gap-research 调度:
 *  - 扫描按 lastAttemptAt 升序(空值优先),无文献的旧 gap 退到队尾(旧实现
 *    按 createdAt 固定队首,老 gap 永久占位、新 gap 轮不到);
 *  - 认领 open→researching 原子抢占(慢 tick/多实例不重复研究);
 *  - 无结果/失败放回 open(保留重试,但已推进退避时间);
 *  - 调度器 running 标志防重入。
 */
const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  search: vi.fn(),
  resolve: vi.fn(),
  propose: vi.fn(async () => ({ id: 'p1' })),
  telemetryRecord: vi.fn(async () => undefined),
  // #1154: 调度器 DB 租约 — mock 侧默认「本实例抢到租约」。
  leaseUpdateMany: vi.fn(async () => ({ count: 1 })),
  leaseCreate: vi.fn(async () => ({})),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    knowledgeGap: { findMany: mocks.findMany, updateMany: mocks.updateMany },
    schedulerLease: { updateMany: mocks.leaseUpdateMany, create: mocks.leaseCreate },
  },
}))
vi.mock('../../src/modules/shared/user-context.js', () => ({
  getUserContext: () => ({ memory: {} }),
}))
vi.mock('../../src/memory/memory-gateway.js', () => ({
  MemoryGraphGateway: class { propose = mocks.propose },
}))
vi.mock('../../src/modules/knowledge/telemetry.service.js', () => ({
  PrismaTelemetryService: class { record = mocks.telemetryRecord },
}))
vi.mock('../../src/modules/knowledge/knowledge-gap.service.js', () => ({
  PrismaKnowledgeGapService: class { resolve = mocks.resolve },
}))
vi.mock('../../src/modules/knowledge/web-search.service.js', () => ({
  createDefaultWebSearchProvider: () => ({ name: 'test-provider', search: mocks.search }),
}))

import { GapResearchService, createGapResearchScheduler, resetStaleResearchingGaps } from '../../src/modules/knowledge/gap-research.service.js'

const ROW = {
  id: 'g1', userId: 'u1', workspaceId: 'w1', content: 'IL-6 与预后?',
  source: 'chat', sourceId: null, status: 'open', answerId: null, answerText: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findMany.mockResolvedValue([ROW])
  mocks.updateMany.mockResolvedValue({ count: 1 })
  mocks.resolve.mockResolvedValue({ id: 'g1' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('#1143 gap-research 认领与退避', () => {
  test('扫描按 lastAttemptAt 升序(空值优先)+ 原子认领,无结果放回 open', async () => {
    mocks.search.mockResolvedValue({ found: false, text: 'no literature' })
    const service = new GapResearchService({ name: 'test-provider', search: mocks.search })

    await service.researchOpenGaps({ maxPerRun: 5 })

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ lastAttemptAt: 'asc' }, { createdAt: 'asc' }],
    }))
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'g1', status: 'open' },
      data: expect.objectContaining({ status: 'researching', attempts: { increment: 1 } }),
    }))
    // 认领后无结果 → 放回 open(可重试,但退避时间已推进)
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'g1', status: 'researching' },
      data: expect.objectContaining({ status: 'open' }),
    }))
    expect(mocks.resolve).not.toHaveBeenCalled()
  })

  test('认领失败(count=0,已被并发 tick 抢走)→ 不再研究该 gap', async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 })
    const service = new GapResearchService({ name: 'test-provider', search: mocks.search })
    const r = await service.researchOpenGaps({})
    expect(mocks.search).not.toHaveBeenCalled()
    expect(r.processed).toBe(0)
  })

  test('研究抛错 → 放回 open 且错误入列(不永久卡 researching)', async () => {
    mocks.search.mockRejectedValue(new Error('search down'))
    const service = new GapResearchService({ name: 'test-provider', search: mocks.search })
    const r = await service.researchOpenGaps({})
    expect(r.errors).toHaveLength(1)
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'g1', status: 'researching' },
      data: expect.objectContaining({ status: 'open' }),
    }))
  })

  test('调度器防重入:慢 tick 未结束时下一 tick 跳过', async () => {
    vi.useFakeTimers()
    let release!: (v: unknown) => void
    mocks.search.mockImplementation(() => new Promise((resolve) => { release = resolve }))

    const scheduler = createGapResearchScheduler(100, {
      provider: { name: 'test-provider', search: mocks.search },
    })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(350) // 3 个 tick 周期,首个仍挂起
    expect(mocks.search).toHaveBeenCalledTimes(1)
    scheduler.stop()
    release({ found: false, text: 'late' })
    await vi.advanceTimersByTimeAsync(10)
  })
})

describe('#1150-followup 残留 researching 回收', () => {
  test('回收 updateMany 将超时 researching 置回 open', async () => {
    mocks.updateMany.mockClear()
    mocks.updateMany.mockResolvedValueOnce({ count: 2 })
    const recovered = await resetStaleResearchingGaps(60_000)
    expect(recovered).toBe(2)
    const call = mocks.updateMany.mock.calls[0][0]
    expect(call.where).toMatchObject({ status: 'researching' })
    expect(call.where.lastAttemptAt).toHaveProperty('lt')
    expect(call.data).toMatchObject({ status: 'open' })
  })
})
