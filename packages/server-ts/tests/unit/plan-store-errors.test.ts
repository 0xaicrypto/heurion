import { describe, test, expect, vi } from 'vitest'

/**
 * #1146 — plan-store 把 DB 故障吞成"无计划":`loadActivePlan/updateSteps` 的
 * `.catch(() => null)` 与 createPlan 取消旧清单的 `.catch(() => undefined)`
 * 让数据库异常静默降级为"没有清单"。修复:error 留痕后原样上抛(chat 装配
 * 链本就有降级 catch)。
 */
const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    taskPlan: {
      findFirst: mocks.findFirst,
      updateMany: mocks.updateMany,
      create: mocks.create,
      update: mocks.update,
    },
  },
}))
vi.mock('../../src/common/logger.js', () => ({
  makeLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: mocks.logError }),
}))

const { loadActivePlan, createPlan, advanceStep } = await import('../../src/common/plan-store.js')

describe('#1146 plan-store DB 故障不当"无计划"', () => {
  test('loadActivePlan DB 故障 → 抛错 + error 留痕（不再静默 null）', async () => {
    mocks.findFirst.mockRejectedValueOnce(new Error('db down'))
    await expect(loadActivePlan('u1', 's1')).rejects.toThrow('db down')
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.stringContaining('loadActivePlan'),
      expect.objectContaining({ reason: expect.stringContaining('db down') }),
    )
  })

  test('createPlan 取消旧清单 DB 故障 → 抛错（不再静默继续建新清单）', async () => {
    mocks.updateMany.mockRejectedValueOnce(new Error('db down'))
    await expect(
      createPlan('u1', 's1', 'T', [{ title: '步骤一' }]),
    ).rejects.toThrow('db down')
    expect(mocks.create).not.toHaveBeenCalled()
  })

  test('advanceStep 写回 DB 故障 → 抛错（不再伪装"无活跃清单"）', async () => {
    mocks.findFirst.mockResolvedValueOnce({
      id: 'p1', sessionId: 's1', title: 'T', status: 'active',
      stepsJson: JSON.stringify([{ index: 1, title: 'A', status: 'pending' }]),
      createdAt: 'x', updatedAt: 'x',
    })
    mocks.update.mockRejectedValueOnce(new Error('db down'))
    await expect(advanceStep('u1', 's1', 1)).rejects.toThrow('db down')
  })
})
