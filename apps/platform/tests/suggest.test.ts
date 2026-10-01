import { describe, expect, it } from 'vitest'
import { serializeBlocks } from '../src/model/markdown.ts'
import { pendingGroups, resolveSuggestions, withoutPending } from '../src/ops/suggest.ts'
import { OpError } from '../src/ops/types.ts'
import { ids, setup } from './helpers.ts'

const blocks = (doc: ReturnType<ReturnType<typeof setup>['docs']['get']>) => {
  const out: Array<{ id: string; text: string; suggest: string | null }> = []
  doc.forEach(n => out.push({ id: n.attrs.id as string, text: n.textContent, suggest: n.attrs.suggest as string | null }))
  return out
}

function suggested() {
  const t = setup('甲段。\n\n乙段。\n\n丙段。')
  const [a, b, c] = ids(t.docs, t.docId)
  t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'suggest', ops: [
    { op: 'replace_text', id: a!, find: '甲段', replace: '甲段（改）' },
    { op: 'insert_after', anchor_id: b!, markdown: '新增段。' },
    { op: 'delete', ids: [c!] },
  ] }, { actor: 'ai', turnId: null })
  return { ...t, a: a!, b: b!, c: c! }
}

describe('suggest 模式', () => {
  it('修改不直接生效：原块待删除、新块待新增、删除的块留在原位待删除', () => {
    const t = suggested()
    const now = blocks(t.docs.get(t.docId))
    expect(now.map(x => [x.text, x.suggest])).toEqual([
      ['甲段。', 'delete'], ['甲段（改）。', 'insert'], ['乙段。', null], ['丙段。', 'delete'], ['新增段。', 'insert'],
    ])
    expect(now[0]!.id).toBe(t.a)
    expect(pendingGroups(t.docs.get(t.docId))).toHaveLength(1)
    // 读视图带修订标记；导出按「未采纳」处理
    const md: ReturnType<typeof t.docs.get>[] = []
    t.docs.get(t.docId).forEach(n => md.push(n))
    expect(serializeBlocks(md, { ids: true })).toContain('⟨待采纳·新增⟩')
    expect(blocks(withoutPending(t.docs.get(t.docId))).map(x => x.text)).toEqual(['甲段。', '乙段。', '丙段。'])
  })

  it('采纳：改动生效，新块接过原块 id', () => {
    const t = suggested()
    const group = pendingGroups(t.docs.get(t.docId))[0]!.group
    const next = resolveSuggestions(t.docs.get(t.docId), group, true)
    const after = blocks(next)
    expect(after.map(x => x.text)).toEqual(['甲段（改）。', '乙段。', '新增段。'])
    expect(after[0]!.id).toBe(t.a)
    expect(after.every(x => x.suggest === null)).toBe(true)
  })

  it('拒绝：恢复原样', () => {
    const t = suggested()
    const next = resolveSuggestions(t.docs.get(t.docId), null, false)
    expect(blocks(next).map(x => [x.id, x.text])).toEqual([[t.a, '甲段。'], [t.b, '乙段。'], [t.c, '丙段。']])
  })

  it('待采纳的块不能再被 AI 修改', () => {
    const t = suggested()
    let err: unknown
    try {
      t.ops.edit({ doc_id: t.docId, base_rev: 1, mode: 'apply', ops: [{ op: 'replace_text', id: t.a, find: '甲段', replace: 'x' }] }, { actor: 'ai', turnId: null })
    } catch (e) { err = e }
    expect((err as OpError).code).toBe('pending_suggestion')
  })

  it('列表项与表格的修订', () => {
    const t = setup('- 一\n- 二\n\n| a | b |\n| --- | --- |\n| 1 | 2 |')
    const list = t.docs.get(t.docId).child(0)
    const table = t.docs.get(t.docId).child(1).attrs.id as string
    const item = list.child(1).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'suggest', ops: [
      { op: 'delete', ids: [item] },
      { op: 'table_set_cells', id: table, cells: [{ row: 1, col: 1, markdown: '3' }] },
    ] }, { actor: 'ai', turnId: null })
    const doc = t.docs.get(t.docId)
    expect(doc.child(0).child(1).attrs.suggest).toBe('delete')
    expect([doc.child(1).attrs.suggest, doc.child(2).attrs.suggest]).toEqual(['delete', 'insert'])
    // 新表格内部的段落 id 与原表格不重复
    const seen = new Set<string>()
    let dup = false
    doc.descendants(n => { if (n.attrs.id) { if (seen.has(n.attrs.id as string)) dup = true; seen.add(n.attrs.id as string) } })
    expect(dup).toBe(false)
    const accepted = resolveSuggestions(doc, null, true)
    expect(accepted.child(0).childCount).toBe(1)
    expect(accepted.childCount).toBe(2)
    expect(accepted.child(1).attrs.id).toBe(table)
    expect(accepted.child(1).textContent).toContain('3')
  })
})
