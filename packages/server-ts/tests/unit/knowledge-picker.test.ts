import { describe, test, expect } from 'vitest'
import { searchPickerItems, type PickerNode } from '../../src/modules/knowledge/knowledge-picker.service.js'

function nodes(): PickerNode[] {
  return [
    { stableId: 'summary_atr', type: 'summary', title: 'ATR 通路综述', content: '放疗抵抗机制与 DNA 损伤修复。', updatedAt: 1 },
    { stableId: 'doc_protocol', type: 'document', title: 'NSCLC001 试验方案', updatedAt: 2 },
    { stableId: 'summary_tki', type: 'summary', title: '三代 EGFR-TKI 研究', content: 'PFS 显著延长。', updatedAt: 3 },
  ]
}

function stubEmbedding(hits: Array<{ stableId: string; content: string; type: string; score: number }>) {
  return { retrieve: async () => hits } as any
}

describe('#633 knowledge picker unified search', () => {
  test('词法路: 标题子串命中,空查询返回全量', async () => {
    const hits = await searchPickerItems(nodes(), 'ATR')
    expect(hits.map((h) => h.node.stableId)).toContain('summary_atr')
    expect(hits.map((h) => h.node.stableId)).not.toContain('summary_tki')

    const all = await searchPickerItems(nodes(), '')
    expect(all.length).toBe(3)
  })

  test('向量路: 语义相近词命中(搜"放疗抵抗"命中 ATR 论文)', async () => {
    const embedding = stubEmbedding([
      { stableId: 'summary_atr', content: '放疗抵抗机制…', type: 'summary', score: 0.7 },
    ])
    const hits = await searchPickerItems(nodes(), '放疗抵抗', embedding)
    expect(hits.some((h) => h.node.stableId === 'summary_atr')).toBe(true)
    // 词法无命中时向量路仍能召回
    expect(hits[0]?.sources).toContain('vector')
  })

  test('embedding 故障 → 回落纯词法,行为不破', async () => {
    const embedding = {
      retrieve: async () => { throw new Error('embedding down') },
    } as any
    const hits = await searchPickerItems(nodes(), 'ATR', embedding)
    expect(hits.some((h) => h.node.stableId === 'summary_atr')).toBe(true)
  })

  test('向量命中不在节点池内(已删除) → 不输出', async () => {
    const embedding = stubEmbedding([
      { stableId: 'deleted_doc', content: 'x', type: 'document', score: 0.9 },
    ])
    const hits = await searchPickerItems(nodes(), 'query', embedding)
    expect(hits.every((h) => h.node.stableId !== 'deleted_doc')).toBe(true)
  })
})
