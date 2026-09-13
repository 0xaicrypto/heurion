import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * #1014 — MemoryUsageBus：append-only 写入（fire-and-forget）与聚合查询。
 */
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findMany: vi.fn(),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    memoryUsageEvent: { create: mocks.create, findMany: mocks.findMany },
  },
}))
vi.mock('../../src/common/logger.js', () => ({ makeLogger: () => new Proxy({}, { get: () => vi.fn() }) }))

import { recordMemoryUsage, getUsageStats, getUsageStatsBulk } from '../../src/memory/memory-usage-bus.js'

beforeEach(() => {
  mocks.create.mockReset()
  mocks.findMany.mockReset()
  mocks.create.mockResolvedValue({})
  mocks.findMany.mockResolvedValue([])
})

describe('#1014 recordMemoryUsage', () => {
  test('写入字段齐全（sessionId 可选）', () => {
    recordMemoryUsage({ userId: 'u1', unitType: 'summary', unitId: 'sum_1', action: 'referenced', sessionId: 'sess_1' })
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1', unitType: 'summary', unitId: 'sum_1', action: 'referenced', sessionId: 'sess_1',
      }),
    })
  })

  test('缺 userId/unitId → 不写；写入失败不抛（fire-and-forget）', async () => {
    recordMemoryUsage({ userId: '', unitType: 'fact', unitId: 'f1', action: 'retrieved' })
    recordMemoryUsage({ userId: 'u1', unitType: 'fact', unitId: '', action: 'retrieved' })
    expect(mocks.create).not.toHaveBeenCalled()

    mocks.create.mockRejectedValueOnce(new Error('db down'))
    expect(() => recordMemoryUsage({ userId: 'u1', unitType: 'fact', unitId: 'f1', action: 'retrieved' })).not.toThrow()
    await new Promise((r) => setTimeout(r, 0)) // 让 rejection 落到 catch
  })
})

describe('#1014 getUsageStats / bulk', () => {
  test('聚合：总数/分动作/最近使用时间', async () => {
    mocks.findMany.mockResolvedValueOnce([
      { action: 'retrieved', at: 't1' },
      { action: 'retrieved', at: 't3' },
      { action: 'referenced', at: 't2' },
    ])
    const stats = await getUsageStats('u1', 'sum_1')
    expect(stats).toEqual({ uses: 3, retrieved: 2, referenced: 1, accepted: 0, dismissed: 0, suggested: 0, lastUsedAt: 't3' })
  })

  test('空记录：全零 + lastUsedAt null', async () => {
    const stats = await getUsageStats('u1', 'none')
    expect(stats).toEqual({ uses: 0, retrieved: 0, referenced: 0, accepted: 0, dismissed: 0, suggested: 0, lastUsedAt: null })
  })

  test('批量：按 unitId 分组，未命中条目零值补齐', async () => {
    mocks.findMany.mockResolvedValueOnce([
      { unitId: 'a', action: 'retrieved', at: 't1' },
      { unitId: 'a', action: 'accepted', at: 't2' },
      { unitId: 'b', action: 'dismissed', at: 't3' },
    ])
    const map = await getUsageStatsBulk('u1', ['a', 'b', 'c'])
    expect(map.get('a')).toMatchObject({ uses: 2, retrieved: 1, accepted: 1, lastUsedAt: 't2' })
    expect(map.get('b')).toMatchObject({ uses: 1, dismissed: 1 })
    expect(map.get('c')?.uses).toBe(0)
  })
})
