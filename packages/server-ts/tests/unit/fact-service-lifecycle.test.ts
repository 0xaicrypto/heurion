import { describe, test, expect } from 'vitest'
import { getUserContext } from '../../src/modules/shared/user-context.js'

/**
 * #1146 测试缺口 — memory/fact-service 直接生命周期测试：
 * add(双写) → supersede(旧节点留审计/legacy 投影移除) → delete(幂等失败)
 * → edit(error 语义)。此前该服务仅被间接覆盖。
 */
function freshMemory() {
  const userId = `fact_lifecycle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const ctx = getUserContext(userId)
  return ctx.memory
}

describe('#1146 fact-service 生命周期', () => {
  test('addFact：图节点 current + legacy 投影双写', () => {
    const memory = freshMemory()
    const fact = memory.addFact(
      { content: '患者对 TKI 耐药后复查活检确认 T790M', category: 'fact', importance: 4, sourceType: 'patient' },
      'user',
    )
    expect(fact.stableId).toMatch(/^fact_/)
    expect(memory.graph.getLatestByStableId(fact.stableId)?.status).toBe('current')
    expect(memory.legacyFacts.all().some((f) => f.id === fact.stableId)).toBe(true)
  })

  test('supersedeFact：图节点转 superseded（审计留档）且 legacy 投影移除；重复 supersede 幂等返回 false', () => {
    const memory = freshMemory()
    const fact = memory.addFact({ content: '旧结论：A 方案有效', category: 'fact', sourceType: 'research' }, 'system')
    expect(memory.supersedeFact(fact.stableId, '被新证据取代')).toBe(true)
    expect(memory.graph.getLatestByStableId(fact.stableId)?.status).toBe('superseded')
    expect(memory.legacyFacts.all().some((f) => f.id === fact.stableId)).toBe(false)
    // 已 superseded → 幂等 false（不重复传播/审计）
    expect(memory.supersedeFact(fact.stableId, 'again')).toBe(false)
  })

  test('editFact：版本前移且内容更新；deleteFact 走 supersede 路径后 edit 返回错误', () => {
    const memory = freshMemory()
    const fact = memory.addFact({ content: '初始结论', category: 'fact', importance: 2, sourceType: 'user' }, 'user')
    const edited = memory.editFact(fact.stableId, { content: '修正后的结论', importance: 5 }, 'user')
    expect(edited.ok).toBe(true)
    const latest = memory.graph.getLatestByStableId(fact.stableId)
    expect(latest?.version).toBe(2)
    expect(latest?.content).toBe('修正后的结论')

    const deleted = memory.deleteFact(fact.stableId, 'user')
    expect(deleted.ok).toBe(true)
    expect(memory.graph.getLatestByStableId(fact.stableId)?.status).toBe('superseded')
    // 删除后不可再编辑（与 superseded 同语义）
    expect(memory.editFact(fact.stableId, { content: 'x' }, 'user').ok).toBe(false)
  })
})
