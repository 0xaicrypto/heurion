import { describe, test, expect } from 'vitest'
import { getAuthUserId } from '../setup.js'
import { getUserContext } from '../../src/modules/shared/user-context.js'
import { MemoryGraphGateway } from '../../src/memory/memory-gateway.js'

/**
 * #1146 — 记忆提案重试重复落图:落图成功但提案行标记失败时审批回滚
 * pending,重试会再落一份图(重复节点)。修复:节点 provenance.proposalId
 * + applyApproved 幂等判重。
 */
describe('#1146 提案落图幂等', () => {
  test('同一提案 apply 两次只落一个节点（重试不再重复落图）', async () => {
    const userId = await getAuthUserId()
    const ctx = getUserContext(userId)
    const gateway = new MemoryGraphGateway(userId, ctx.memory, ctx.episodes)

    const proposal = await gateway.propose({
      scopeType: 'global',
      kind: 'fact',
      content: `幂等落图用例事实 ${Date.now()}`,
      importance: 3,
      confidence: 'medium',
      reason: 'idempotency test seed',
    })

    const before = ctx.memory.graph.nodeCount
    const first = await gateway.applyApproved(proposal)
    expect(first).toBeTruthy()
    const afterFirst = ctx.memory.graph.nodeCount

    // 模拟审批重试（回滚 pending 后再次确认）— 修复前会再落一份。
    const second = await gateway.applyApproved(proposal)
    expect(ctx.memory.graph.nodeCount).toBe(afterFirst)
    expect(second?.stableId).toBe(first?.stableId)

    expect(afterFirst).toBe(before + 1)
  }, 30000)
})
