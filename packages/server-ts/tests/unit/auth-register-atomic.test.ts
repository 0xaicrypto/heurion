import { describe, test, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

/**
 * #1137 — 首个用户 admin 判定 count/create 必须同事务原子。
 * 行为回归在 e2e(并发同名 → 409 无 500);这里锁实现形状:注册在
 * prisma.$transaction 内先 tx.user.count 再 tx.user.create(count=0 → admin),
 * 防止后续重构把两者拆开重新引入并发双 admin。
 */
const mocks = vi.hoisted(() => {
  const tx = { user: { count: vi.fn(), create: vi.fn() } }
  return {
    tx,
    transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    userFindFirst: vi.fn(),
  }
})

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    user: { findFirst: mocks.userFindFirst },
    $transaction: mocks.transaction,
  },
}))

import { authRouter } from '../../src/modules/auth/auth.router.js'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.userFindFirst.mockResolvedValue(null)
  mocks.tx.user.count.mockResolvedValue(0)
  mocks.tx.user.create.mockImplementation(async (args: { data: { id: string; role: string } }) => ({
    id: args.data.id,
    role: args.data.role,
  }))
})

describe('#1137 注册角色判定原子性', () => {
  test('空库首个用户:count→create 在同一事务内,role=admin,username 落库', async () => {
    const app = Fastify()
    await app.register(authRouter)
    await app.ready()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'atomic_u1', password: 'secret1', display_name: '张医生' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).role).toBe('admin')

    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.tx.user.count).toHaveBeenCalledTimes(1)
    expect(mocks.tx.user.create).toHaveBeenCalledTimes(1)
    // #1136: 登录标识与显示名分别落库
    const data = mocks.tx.user.create.mock.calls[0][0].data
    expect(data.username).toBe('atomic_u1')
    expect(data.displayName).toBe('张医生')
    expect(data.role).toBe('admin')
    await app.close()
  })

  test('并发唯一约束冲突(P2002)→ 409,不冒泡 500', async () => {
    mocks.tx.user.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }))
    const app = Fastify()
    await app.register(authRouter)
    await app.ready()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'atomic_u2', password: 'secret1' },
    })
    expect(res.statusCode).toBe(409)
    await app.close()
  })
})
