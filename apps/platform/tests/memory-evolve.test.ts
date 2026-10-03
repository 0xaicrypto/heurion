import { describe, expect, it } from 'vitest'
import { MemoryEvolution, stripIds } from '../src/memory/evolve.ts'
import { MemoryError, MemoryService } from '../src/memory/service.ts'
import { MemorySignals } from '../src/memory/signals.ts'
import { resolveSuggestions } from '../src/ops/suggest.ts'
import { ids, setup } from './helpers.ts'

const AI = { actor: 'ai' as const, turnId: 't1' }
const USER = { actor: 'user' as const, turnId: null }

function env(reply: (input: any) => unknown = () => ({ changes: [] })) {
  const t = setup('第一段，AI 之后会写。\n\n第二段。\n\n第三段。')
  const memory = new MemoryService(t.store, null)
  new MemorySignals(t.store, memory, t.docs)
  const seen: any[] = []
  const evo = new MemoryEvolution(t.store, memory, t.docs, async (_system, user) => {
    const input = JSON.parse(user)
    seen.push(input)
    return '```json\n' + JSON.stringify(reply(input)) + '\n```'
  })
  const [a, b, c] = ids(t.docs, t.docId)
  return { ...t, memory, evo, seen, a: a!, b: b!, c: c! }
}

describe('记忆演进：信号', () => {
  it('用户改了 AI 写的段落：记下 AI 原文；整理时取段落当前文字（多次修改取最终结果）', async () => {
    const t = env()
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: t.a, find: '第一段，AI 之后会写。', replace: '治疗组死亡风险显著降低。' }] }, AI)
    t.ops.edit({ doc_id: t.docId, base_rev: 1, mode: 'apply', ops: [{ op: 'replace_text', id: t.a, find: '显著降低', replace: '降低 26%' }] }, USER)
    t.ops.edit({ doc_id: t.docId, base_rev: 2, mode: 'apply', ops: [{ op: 'replace_text', id: t.a, find: '降低 26%', replace: '降低 26%（HR 0.74）' }] }, USER)
    // 用户改自己写的段落不算
    t.ops.edit({ doc_id: t.docId, base_rev: 3, mode: 'apply', ops: [{ op: 'replace_text', id: t.b, find: '第二段', replace: '第二段改' }] }, USER)
    const open = t.store.openMemorySignals('u1')
    expect(open.map(s => [s.kind, s.ai_text])).toEqual([['edit_ai', '治疗组死亡风险显著降低。']])
    await t.evo.review('u1')
    expect(t.seen[0].signals).toEqual([{ id: 's1', type: 'edit_ai', ai_text: '治疗组死亡风险显著降低。', user_text: '治疗组死亡风险降低 26%（HR 0.74）。' }])
    expect(t.store.openMemorySignals('u1')).toHaveLength(0)
  })

  it('拒绝修订：记下被拒的 AI 版本与保留的原文；暂停记忆时不收集', () => {
    const t = env()
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'suggest', ops: [{ op: 'replace_text', id: t.b, find: '第二段', replace: '第二部分' }] }, AI)
    const reject = () => {
      const next = resolveSuggestions(t.docs.get(t.docId), null, false)
      t.docs.commit(t.docId, next, { ...USER, ops: [{ op: 'reject_suggestion', group: null }] })
    }
    reject()
    expect(t.store.openMemorySignals('u1').map(s => [s.kind, s.ai_text, s.user_text])).toEqual([['reject', '第二部分。', '第二段。']])

    t.memory.setPaused('u1', true)
    t.ops.edit({ doc_id: t.docId, base_rev: t.docs.rev(t.docId), mode: 'suggest', ops: [{ op: 'replace_text', id: t.c, find: '第三段', replace: '第三部分' }] }, AI)
    reject()
    expect(t.store.openMemorySignals('u1')).toHaveLength(1)
  })
})

describe('记忆演进：整理', () => {
  it('新规律进「待确认」；合并 / 改写 / 归档进整理建议；采纳后生效，历史可查', async () => {
    const t = env(input => {
      const id = (text: string) => input.memories.find((m: any) => m.content === text).id
      return { changes: [
        { action: 'create', kind: 'style', content: '效应量写具体数值和 HR，不写「显著」', reason: '你两次把「显著降低」改成了效应量', evidence: ['s1', 's2'] },
        { action: 'merge', ids: [id('数值保留两位小数'), id('小数保留两位')], content: '数值一律保留两位小数', reason: '两条说的是同一件事' },
        { action: 'update', id: id('参考文献用 Vancouver 格式'), content: '参考文献用 AMA 格式', reason: '你最近说改用 AMA' },
        { action: 'archive', id: id('统计软件用 SPSS'), reason: '最近都在用 R' },
        { action: 'update', id: 'm999', content: '不存在的记忆', reason: '应被忽略' },
        { action: 'create', kind: 'fact', content: '患者王某某，男，65岁', reason: '敏感，应被拦下' },
      ] }
    })
    for (const content of ['数值保留两位小数', '小数保留两位', '参考文献用 Vancouver 格式', '统计软件用 SPSS']) await t.memory.propose('u1', { content, kind: 'preference', scope: 'global' }, { source: 'manual', actor: 'user' })
    const r = await t.evo.review('u1')
    expect(r.proposed.map(m => [m.content, m.status, m.source])).toEqual([['效应量写具体数值和 HR，不写「显著」', 'proposed', 'review']])
    expect(r.changes.map(c => c.action)).toEqual(['merge', 'update', 'archive'])
    // 什么都没自动生效
    expect(t.store.listMemories('u1', ['active']).map(m => m.content).sort()).toEqual(['参考文献用 Vancouver 格式', '小数保留两位', '数值保留两位小数', '统计软件用 SPSS'])

    for (const c of r.changes) await t.evo.apply('u1', c.id)
    expect(t.store.listMemories('u1', ['active']).map(m => m.content).sort()).toEqual(['参考文献用 AMA 格式', '数值一律保留两位小数'])
    expect(t.store.listMemories('u1', ['archived'])).toHaveLength(2)
    const merged = t.store.listMemories('u1', ['active']).find(m => m.content === '数值一律保留两位小数')!
    expect(t.store.memoryEvents(merged.id).map(e => e.action)).toEqual(['create', 'edit'])
    expect(t.evo.pending('u1')).toHaveLength(0)
    await expect(t.evo.apply('u1', r.changes[0]!.id)).rejects.toThrow(MemoryError)
  })

  it('忽略过的建议告诉模型别再提；目标记忆变了的建议作废；别人的建议碰不到', async () => {
    const t = env(input => ({ changes: input.memories.length ? [{ action: 'archive', id: 'm1', reason: '不再适用' }] : [] }))
    await t.memory.propose('u1', { content: '图表标题放在图下方', kind: 'style', scope: 'global' }, { source: 'manual', actor: 'user' })
    const [c1] = (await t.evo.review('u1')).changes
    t.evo.dismiss('u1', c1!.id)
    await t.evo.review('u1')
    expect(t.seen[1].dismissed).toEqual(['不再适用'])

    const [c2] = t.evo.pending('u1')
    expect(() => t.evo.dismiss('u2', c2!.id)).toThrow(MemoryError)
    await expect(t.evo.apply('u2', c2!.id)).rejects.toThrow('建议不存在')
    t.store.deleteMemory(c2!.target_ids[0]!)
    await expect(t.evo.apply('u1', c2!.id)).rejects.toThrow('作废')
  })

  it('长期没用到的记忆提议归档（明确要求记住的不提）；使用会刷新；定时整理没有新东西时跳过', async () => {
    const t = env()
    const old = await t.memory.propose('u1', { content: '摘要不超过 250 字', kind: 'preference', scope: 'global' }, { source: 'manual', actor: 'user' })
    const kept = await t.memory.propose('u1', { content: '作者署名按贡献排序', kind: 'preference', scope: 'global', explicit: true }, { source: 'turn', actor: 'ai' })
    const long = new Date(Date.now() - 120 * 86_400_000).toISOString()
    ;(t.store as any).db.prepare('UPDATE memories SET created_at = ?, last_used_at = NULL').run(long)
    expect((await t.evo.review('u1', { force: false })).changes.map(c => [c.action, c.target_ids[0], c.reason])).toEqual([['archive', old.memory.id, '90 天以上没有用到']])
    expect((await t.evo.review('u1', { force: false })).skipped).toBe('nothing_new')

    // 注入回合即算使用
    await t.memory.forPrompt('u1', t.docId, '写摘要')
    expect(t.store.getMemory(kept.memory.id)!.use_count).toBe(1)
  })

  it('记忆停用或暂停时不能整理；没有模型时不可用', async () => {
    const t = env()
    t.memory.setPaused('u1', true)
    await expect(t.evo.review('u1')).rejects.toMatchObject({ code: 'memory_off' })
    const none = new MemoryEvolution(t.store, t.memory, t.docs, null)
    expect(none.available()).toBe(false)
    await expect(none.review('u1')).rejects.toMatchObject({ code: 'review_unavailable' })
  })
})

describe('记忆演进：给用户看的文字', () => {
  it('去掉模型漏写的内部编号，单位和剂量里的字母数字不动', () => {
    expect(stripIds('m2「图题放在图片下面」与 m3「图注写在图的下方」说的是同一件事')).toBe('「图题放在图片下面」与 「图注写在图的下方」说的是同一件事')
    expect(stripIds('你在 3 处改成了效应量（s1、s2、s5）')).toBe('你在 3 处改成了效应量')
    expect(stripIds('剂量 10 mg，随访 6 m，HbA1c 下降')).toBe('剂量 10 mg，随访 6 m，HbA1c 下降')
  })
})
