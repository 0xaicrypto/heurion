import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBlocks } from '../src/model/markdown.ts'
import { Documents } from '../src/model/runtime.ts'
import { schema } from '../src/model/schema.ts'
import { OpService } from '../src/ops/service.ts'
import { Store } from '../src/store/db.ts'

const texts = (docs: Documents, id: string) => {
  const out: string[] = []
  docs.get(id).forEach(n => out.push(n.textContent))
  return out
}

describe('撤销本轮（服务重启后）', () => {
  it('按节点撤销：恢复改过的块、删掉新增的块、放回删掉的块，用户之后改过的块跳过', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'heurion-revert-')), 'p.db')
    const docId = (() => {
      const store = new Store(path)
      const docs = new Documents(store)
      const ops = new OpService(docs)
      const row = docs.create({ owner: 'u', title: 't', content: schema.node('doc', null, parseBlocks('甲。\n\n乙。\n\n丙。\n\n丁。')) })
      const ids: string[] = []
      docs.get(row.id).forEach(n => ids.push(n.attrs.id as string))
      const [a, b, c, d] = ids
      ops.edit({ doc_id: row.id, base_rev: 0, mode: 'apply', ops: [
        { op: 'replace_text', id: a!, find: '甲', replace: 'AI 甲' },
        { op: 'replace_text', id: d!, find: '丁', replace: 'AI 丁' },
        { op: 'insert_after', anchor_id: b!, markdown: 'AI 新增。' },
        { op: 'delete', ids: [c!] },
      ] }, { actor: 'ai', turnId: 'r1' })
      // 回合之后用户又改了「丁」
      ops.edit({ doc_id: row.id, base_rev: 1, mode: 'apply', ops: [{ op: 'replace_text', id: d!, find: 'AI 丁', replace: '用户丁' }] }, { actor: 'user', turnId: null })
      return row.id
    })()

    // 「重启」：新的 Documents，没有内存里的撤销器
    const store = new Store(path)
    const docs = new Documents(store)
    expect(texts(docs, docId)).toEqual(['AI 甲。', '乙。', 'AI 新增。', '用户丁。'])
    expect(docs.canRevertTurn(docId, 'r1')).toBe(true)
    const result = docs.revertTurn(docId, 'r1')!
    expect(texts(docs, docId)).toEqual(['甲。', '乙。', '丙。', '用户丁。'])
    expect(result.skipped).toHaveLength(1)
    expect(docs.canRevertTurn(docId, 'r1')).toBe(false)
  })
})
