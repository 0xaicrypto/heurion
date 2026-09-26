import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * P0 — 审批确认/拒绝的原子抢占。
 *
 * 修复前：findFirst(pending) → applyTargetUpdate → update 的 check-then-act,
 * 两个并发 confirm 都会读到 pending，记忆提案重复落图、审计重复写入；
 * confirm 与 reject 并发时两者都会执行，终态互相覆盖。
 * 修复后：单条 updateMany 抢占 pending → resolved，只有 count===1 的调用者
 * 执行 target 更新。
 */
const mocks = vi.hoisted(() => {
  const state = {
    row: {
      id: 'ap1',
      userId: 'u1',
      targetType: 'MedicalRecordEntry',
      targetId: 'mre1',
      status: 'pending',
      payload: '{}',
      diff: null,
      reason: null as string | null,
      actorId: null as string | null,
      createdAt: '2026-01-01T00:00:00Z',
      resolvedAt: null as string | null,
    },
  }
  return {
    state,
    approvalUpdateMany: vi.fn(),
    approvalFindUnique: vi.fn(),
    entryUpdateMany: vi.fn(),
    auditCreate: vi.fn(),
  }
})

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    approvalRequest: {
      updateMany: mocks.approvalUpdateMany,
      findUnique: mocks.approvalFindUnique,
    },
    medicalRecordEntry: { updateMany: mocks.entryUpdateMany },
    auditLog: { create: mocks.auditCreate },
  },
}))

import { confirmApproval, rejectApproval } from '../../src/modules/approvals/approval.service.js'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.row.status = 'pending'
  mocks.state.row.actorId = null
  mocks.state.row.resolvedAt = null
  mocks.state.row.reason = null
  // 模拟 DB 单条原子抢占：仅当 id + status 同时匹配时生效。
  mocks.approvalUpdateMany.mockImplementation(async (args: { where: { id: string; status: string; userId?: string }; data: Record<string, unknown> }) => {
    const r = mocks.state.row
    const ownerMatches = !args.where.userId || args.where.userId === r.userId
    if (r.id === args.where.id && r.status === args.where.status && ownerMatches) {
      Object.assign(r, args.data)
      return { count: 1 }
    }
    return { count: 0 }
  })
  mocks.approvalFindUnique.mockImplementation(async () => ({ ...mocks.state.row }))
  mocks.entryUpdateMany.mockResolvedValue({ count: 1 })
  mocks.auditCreate.mockResolvedValue({})
})

describe('P0 审批原子抢占', () => {
  test('并发 confirm：唯一胜者执行 target 更新，败者按找不到报错', async () => {
    const results = await Promise.allSettled([confirmApproval('u1', 'ap1'), confirmApproval('u1', 'ap1')])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0].reason.message)).toContain('not found')
    // target 只应用一次 + 审计只写一次
    expect(mocks.entryUpdateMany).toHaveBeenCalledTimes(1)
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1)
    expect(mocks.state.row.status).toBe('approved')
  })

  test('confirm 与 reject 并发：终态唯一（不会先确认又拒绝）', async () => {
    const results = await Promise.allSettled([confirmApproval('u1', 'ap1'), rejectApproval('u1', 'ap1', 'r')])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(mocks.entryUpdateMany).toHaveBeenCalledTimes(1)
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1)
    expect(['approved', 'rejected']).toContain(mocks.state.row.status)
  })

  test('target 应用失败 → 抢占回滚 pending 且错误上抛（可重试，不出现“已批准未落地”）', async () => {
    mocks.entryUpdateMany.mockResolvedValue({ count: 0 }) // applyTargetUpdate 抛 not found
    await expect(confirmApproval('u1', 'ap1')).rejects.toThrow(/not found/)
    expect(mocks.state.row.status).toBe('pending')
    expect(mocks.auditCreate).not.toHaveBeenCalled()
  })

  test('抢占条件带 userId（他人审批 id 一律拒绝）', async () => {
    await expect(confirmApproval('userB', 'ap1')).rejects.toThrow('Approval request not found')
    expect(mocks.approvalUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ap1', status: 'pending', userId: 'userB' },
    }))
    expect(mocks.entryUpdateMany).not.toHaveBeenCalled()
  })
})
