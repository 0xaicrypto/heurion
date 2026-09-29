import { describe, test, expect, vi } from 'vitest'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import { getUserContext } from '../../src/modules/shared/user-context.js'
import { MemoryGraphGateway } from '../../src/memory/memory-gateway.js'
import prisma from '../../src/common/prisma.js'

/**
 * #1146 — approvals 路由错误映射:此前 catch-all → 404，DB 故障被谎报为
 * "找不到"（客户端以为请求不存在/已被处理）。
 * 修复后:仅 NotFoundError → 404，其他异常走全局 500。
 *
 * 注意:prisma 是 Proxy,spy 后 mockRestore 可能弄丢 delegate 方法 —
 * 404 用例（无需 spy）必须排前，DB 故障用例放最后。
 */
describe('#1146 approvals 错误映射', () => {
  test('确实不存在 → 仍是 404（保留原语义）', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/approvals/ap_does_not_exist_0001/confirm',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(404)
  }, 30000)

  test('DB 故障（抢占 updateMany 抛错）→ 500，不再伪装 404', async () => {
    // 先建一条真实 pending（DB 故障注入在其后，避免影响 seed）。
    const userId = await getAuthUserId()
    const ctx = getUserContext(userId)
    const gateway = new MemoryGraphGateway(userId, ctx.memory, ctx.episodes)
    await gateway.propose({
      scopeType: 'global',
      kind: 'fact',
      content: `错误映射用例事实 ${Date.now()}`,
      importance: 3,
      confidence: 'medium',
      reason: 'test seed',
    })
    const app = await getApp()
    const pending = await app.inject({ method: 'GET', url: '/api/v1/approvals/pending', headers: await authHeader() })
    const req = JSON.parse(pending.payload).requests.find((r: { targetType: string }) => r.targetType === 'MemoryProposal')
    expect(req).toBeTruthy()

    const spy = vi.spyOn(prisma.approvalRequest, 'updateMany').mockRejectedValueOnce(new Error('db down'))
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${req.id}/confirm`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(500)

    spy.mockRestore()
  }, 30000)
})
