import { describe, test, expect } from 'vitest'
import prisma from '../../src/common/prisma.js'
import { acquireSchedulerLease } from '../../src/common/scheduler-lease.js'

/**
 * #1154 — 调度器 DB 租约：多实例/滚动发布下同名调度器只有一个持有者。
 * 修复前无此机制（6 个 setInterval 无分布式锁）——本测试在旧代码上因模块
 * 不存在而必挂。
 */
describe('#1154 调度器 DB 租约', () => {
  const leaseName = () => `test-lease-${Math.random().toString(36).slice(2, 8)}`

  test('第二持有者被拒;过期可接管;持有者可续约', async () => {
    const name = leaseName()
    expect(await acquireSchedulerLease(name, 60_000, 'h1')).toBe(true)
    // 有效租约期内其他持有者被拒
    expect(await acquireSchedulerLease(name, 60_000, 'h2')).toBe(false)

    // 模拟过期 → 可被接管
    await prisma.schedulerLease.update({
      where: { name },
      data: { expiresAt: new Date(Date.now() - 1000).toISOString() },
    })
    expect(await acquireSchedulerLease(name, 60_000, 'h2')).toBe(true)
    // H2 续约成功；H1/H3 抢不到
    expect(await acquireSchedulerLease(name, 60_000, 'h2')).toBe(true)
    expect(await acquireSchedulerLease(name, 60_000, 'h1')).toBe(false)
    expect(await acquireSchedulerLease(name, 60_000, 'h3')).toBe(false)

    const row = await prisma.schedulerLease.findUnique({ where: { name } })
    expect(row?.holder).toBe('h2')
    await prisma.schedulerLease.deleteMany({ where: { name } })
  })

  test('不同名字互不影响（不同调度器并行）', async () => {
    const a = leaseName(); const b = leaseName()
    expect(await acquireSchedulerLease(a, 60_000, 'h1')).toBe(true)
    expect(await acquireSchedulerLease(b, 60_000, 'h1')).toBe(true)
    await prisma.schedulerLease.deleteMany({ where: { name: { in: [a, b] } } })
  })
})
