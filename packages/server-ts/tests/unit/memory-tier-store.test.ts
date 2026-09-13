import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * #1015 — MemoryTierStore：Facts/Summary/Persona 三层统一读写 + 升降级留痕。
 */
const mocks = vi.hoisted(() => ({
  tierCreate: vi.fn(),
  tierFindMany: vi.fn(),
  refFindMany: vi.fn(),
  refFindUnique: vi.fn(),
  refCreate: vi.fn(),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    memoryTierEvent: { create: mocks.tierCreate, findMany: mocks.tierFindMany },
    referenceItem: { findMany: mocks.refFindMany, findUnique: mocks.refFindUnique, create: mocks.refCreate },
  },
}))
vi.mock('../../src/common/logger.js', () => ({ makeLogger: () => new Proxy({}, { get: () => vi.fn() }) }))

import { FactTierStore, SummaryTierStore, PersonaTierStore, SkillTierStore, ReferenceTierStore, listTierEvents } from '../../src/memory/memory-tier-store.js'

function fakeMemory() {
  const facts = [
    { type: 'fact', stableId: 'f1', content: 'NSCLC 事实', category: 'fact', importance: 5, patientHash: 'p1', sourceType: 'general', status: 'current' },
    { type: 'fact', stableId: 'f2', content: '全局事实', category: 'goal', importance: 3, sourceType: 'general', status: 'current' },
  ]
  const summaries = [
    { type: 'summary', stableId: 's1', title: 'EGFR 总结', content: '总结正文', status: 'current', sourceFacts: [{ stableId: 'f1' }], staleBecause: [] },
    { type: 'summary', stableId: 's2', title: '旧总结', content: '旧', status: 'superseded' },
  ]
  const skills = [
    { type: 'skill', stableId: 'sk1', name: '文献写作流程', description: '检索→写入', lifecycle: 'active', successCount: 3, taskCount: 4, followRate: 0.75 },
  ]
  return {
    graph: {
      getCurrentNodesByType: (t: string) =>
        t === 'fact' ? facts : t === 'summary' ? summaries : t === 'skill' ? skills : [],
      commit: vi.fn(),
    },
    addFact: vi.fn(),
    addSummary: vi.fn(),
  } as any
}

beforeEach(() => {
  mocks.tierCreate.mockReset().mockImplementation(async ({ data }: any) => ({ id: 'evt_1', ...data }))
  mocks.tierFindMany.mockReset().mockResolvedValue([])
  mocks.refFindMany.mockReset().mockResolvedValue([])
  mocks.refFindUnique.mockReset().mockResolvedValue(null)
  mocks.refCreate.mockReset().mockImplementation(async ({ data }: any) => data)
})

describe('#1015 MemoryTierStore', () => {
  test('FactTierStore.read：映射 + patientHash 过滤；write 走 addFact(system)', async () => {
    const mem = fakeMemory()
    const store = new FactTierStore('u1', mem)
    const all = await store.read()
    expect(all.map((u) => u.id)).toEqual(['f1', 'f2'])
    expect(all[0]).toMatchObject({ tier: 'fact', label: 'fact', content: 'NSCLC 事实' })
    expect((await store.read({ patientHash: 'p1' })).map((u) => u.id)).toEqual(['f1'])

    await store.write({ id: 'new', label: 'fact', content: '新事实', meta: { importance: 4, category: 'exam' } })
    expect(mem.addFact).toHaveBeenCalledWith(expect.objectContaining({ content: '新事实', importance: 4, category: 'exam' }), 'system')
  })

  test('SummaryTierStore.read：只含 current；write 走 addSummary(system)', async () => {
    const mem = fakeMemory()
    const store = new SummaryTierStore('u1', mem)
    const units = await store.read()
    expect(units.map((u) => u.id)).toEqual(['s1'])
    expect(units[0]).toMatchObject({ tier: 'summary', label: 'EGFR 总结' })

    await store.write({ id: 'new', label: '新总结', content: '正文' })
    expect(mem.addSummary).toHaveBeenCalledWith({ title: '新总结', content: '正文' }, 'system')
  })

  test('PersonaTierStore：read 走注入渲染器；write 为 no-op（派生视图）', async () => {
    const store = new PersonaTierStore('u1', () => 'persona 文本')
    const units = await store.read()
    expect(units).toEqual([{ id: 'persona:u1', tier: 'persona', label: 'persona', content: 'persona 文本' }])
    await expect(store.write({ id: 'x', label: 'persona', content: 'y' })).resolves.toBeUndefined()
  })

  test('promote/demote 一律留痕：from/to/action/reason 落库', async () => {
    const store = new FactTierStore('u1', fakeMemory())
    const ev = await store.promote('f1', 'fact', 'summary', '被合成进总结')
    expect(mocks.tierCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1', unitId: 'f1', fromTier: 'fact', toTier: 'summary', action: 'promote', reason: '被合成进总结' }),
    })
    expect(ev.action).toBe('promote')

    await store.demote('f1', 'summary', 'fact', '总结被折叠')
    expect(mocks.tierCreate).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ action: 'demote', fromTier: 'summary', toTier: 'fact' }),
    })
  })

  test('留痕失败 best-effort：返回事件（id 空）不抛', async () => {
    mocks.tierCreate.mockRejectedValueOnce(new Error('db down'))
    const store = new FactTierStore('u1', fakeMemory())
    const ev = await store.demote('f1', 'fact', 'persona', 'reason')
    expect(ev.id).toBe('')
    expect(ev.action).toBe('demote')
  })

  test('listTierEvents：按时间倒序映射', async () => {
    mocks.tierFindMany.mockResolvedValueOnce([
      { id: 'e2', userId: 'u1', unitId: 's1', fromTier: 'fact', toTier: 'summary', action: 'promote', reason: 'r', at: 't2' },
    ])
    const events = await listTierEvents('u1', 5)
    expect(events[0]).toMatchObject({ id: 'e2', fromTier: 'fact', toTier: 'summary', action: 'promote' })
  })
})

describe('#1016 SkillTierStore', () => {
  test('read：graph SkillNode 映射（lifecycle/统计入 meta）', async () => {
    const store = new SkillTierStore('u1', fakeMemory())
    const units = await store.read()
    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({ id: 'sk1', tier: 'skill', label: '文献写作流程', meta: { lifecycle: 'active', followRate: 0.75 } })
  })

  test('write 为边界 no-op（技能创建走捕获/审批/晋升管线）', async () => {
    const mem = fakeMemory()
    const store = new SkillTierStore('u1', mem)
    await expect(store.write({ id: 'x', label: 'n', content: 'c' })).resolves.toBeUndefined()
    expect(mem.addFact).not.toHaveBeenCalled()
  })

  test('demote → lifecycle=suspended + commit + 留痕；promote → active', async () => {
    const mem = fakeMemory()
    const store = new SkillTierStore('u1', mem)
    const ev = await store.demote('sk1', 'skill', 'skill', 'auto-suspend: followRate 0.25')
    expect(ev.action).toBe('demote')
    expect(mem.graph.commit).toHaveBeenCalled()
    const skill = mem.graph.getCurrentNodesByType('skill')[0]
    expect(skill.lifecycle).toBe('suspended')
    expect(mocks.tierCreate).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ unitId: 'sk1', action: 'demote', reason: 'auto-suspend: followRate 0.25' }),
    })

    await store.promote('sk1', 'skill', 'skill', 'manual restore')
    expect(skill.lifecycle).toBe('active')
  })
})

describe('#1017 ReferenceTierStore', () => {
  test('read：ReferenceItem 映射为 reference 单元', async () => {
    mocks.refFindMany.mockResolvedValueOnce([
      { id: 'ref_1', userId: 'u1', kind: 'kb_summary', sourceRef: 'sum_1', label: '总结材料', snapshot: '正文' },
    ])
    const store = new ReferenceTierStore('u1')
    const units = await store.read()
    expect(units[0]).toMatchObject({ id: 'ref_1', tier: 'reference', label: '总结材料', meta: { kind: 'kb_summary', sourceRef: 'sum_1' } })
  })

  test('write：经确定性 ID 幂等落库（lib/reference-store）', async () => {
    const store = new ReferenceTierStore('u1')
    await store.write({ id: 'x', label: '材料', content: '正文', meta: { kind: 'pasted_text' } })
    expect(mocks.refFindUnique).toHaveBeenCalledTimes(1)
    expect(mocks.refCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1', kind: 'pasted_text', label: '材料', snapshot: '正文' }),
    })
  })

  test('promote/demote：固定为引用/取消引用留痕（from/to 均 reference）', async () => {
    const store = new ReferenceTierStore('u1')
    const ev = await store.promote('ref_1', 'reference', 'reference', 'mounted to session sess_1')
    expect(ev.action).toBe('promote')
    expect(mocks.tierCreate).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ unitId: 'ref_1', fromTier: 'reference', toTier: 'reference', action: 'promote' }),
    })
    await store.demote('ref_1', 'reference', 'reference', 'unmounted from session sess_1')
    expect(mocks.tierCreate).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ action: 'demote', reason: 'unmounted from session sess_1' }),
    })
  })
})
