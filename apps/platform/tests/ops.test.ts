import { describe, expect, it } from 'vitest'
import { attachComment } from '../src/model/anchors.ts'
import { parseBlocks, serializeBlocks } from '../src/model/markdown.ts'
import { schema } from '../src/model/schema.ts'
import { OpError } from '../src/ops/types.ts'
import { outline, read } from '../src/views/read.ts'
import { exportMarkdown } from '../src/views/render.ts'
import { ids, setup } from './helpers.ts'

const SAMPLE = `# 引言

心力衰竭是**常见**疾病。

## 方法

- 第一项
- 第二项

| 指标 | 值 |
| --- | --- |
| HR | 0.8 |`

function expectOpError(fn: () => unknown, code: string): OpError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(OpError)
    expect((err as OpError).code).toBe(code)
    return err as OpError
  }
  throw new Error(`expected OpError ${code}`)
}

describe('markdown 方言', () => {
  it('读视图 markdown 往返：结构与格式保留，{#id} 前缀被忽略', () => {
    const doc = schema.node('doc', null, parseBlocks(SAMPLE))
    const blocks: ReturnType<typeof schema.node>[] = []
    doc.forEach(n => blocks.push(n))
    const md = serializeBlocks(blocks)
    expect(md).toContain('**常见**')
    expect(md).toContain('| HR | 0.8 |')
    const again = schema.node('doc', null, parseBlocks(md.replace('# 引言', '{#h1aa} # 引言').replace('心力衰竭', '{#abcd} 心力衰竭')))
    expect(again.textContent).toBe(doc.textContent)
  })

  it('引用标记解析为原子节点', () => {
    const [p] = parseBlocks('见文献[@c:c1234567]。')
    expect(p!.child(1).type.name).toBe('citation')
    expect(p!.child(1).attrs.cite_id).toBe('c1234567')
  })
})

describe('doc_edit 操作', () => {
  it('insert_after / replace_text / delete / move', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const [h1, p1, h2] = ids(docs, docId)
    const r1 = ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [
      { op: 'insert_after', anchor_id: p1!, markdown: '新增段落一。\n\n新增段落二。' },
      { op: 'replace_text', id: p1!, find: '常见', replace: '高发' },
    ] }, { actor: 'ai', turnId: null })
    expect(r1.rev).toBe(1)
    expect(r1.results[0]!.ids).toHaveLength(2)
    const text = docs.get(docId).textContent
    expect(text).toContain('心力衰竭是高发疾病')
    expect(text).toContain('新增段落二')
    // 替换继承原格式（粗体）
    const p = docs.get(docId).child(1)
    expect(p.child(1).marks.map(m => m.type.name)).toEqual(['bold'])

    const added = r1.results[0]!.ids
    ops.edit({ doc_id: docId, base_rev: 1, mode: 'apply', ops: [
      { op: 'move', ids: [added[1]!], after: h1! },
      { op: 'delete', ids: [h2!] },
    ] }, { actor: 'ai', turnId: null })
    const now = ids(docs, docId)
    expect(now[1]).toBe(added[1])
    expect(now).not.toContain(h2)
  })

  it('批次原子：一个 op 失败则整批不生效', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const before = docs.get(docId)
    const [, p1] = ids(docs, docId)
    expectOpError(() => ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [
      { op: 'replace_text', id: p1!, find: '常见', replace: '高发' },
      { op: 'delete', ids: ['nope'] },
    ] }, { actor: 'ai', turnId: null }), 'node_not_found')
    expect(docs.get(docId).eq(before)).toBe(true)
    expect(docs.rev(docId)).toBe(0)
  })

  it('replace_text：找不到时返回当前原文；多处匹配要求 occurrence', () => {
    const { docs, ops, docId } = setup('甲乙甲乙')
    const [p] = ids(docs, docId)
    const e = expectOpError(() => ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p!, find: '丙', replace: 'x' }] }, { actor: 'ai', turnId: null }), 'text_not_found')
    expect(String(e.extra.current)).toContain('甲乙甲乙')
    expectOpError(() => ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p!, find: '甲', replace: 'x' }] }, { actor: 'ai', turnId: null }), 'ambiguous_match')
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p!, find: '甲', replace: 'x', occurrence: 2 }] }, { actor: 'ai', turnId: null })
    expect(docs.get(docId).textContent).toBe('甲乙x乙')
  })

  it('列表与表格操作', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const doc = docs.get(docId)
    const list = doc.child(3)
    const item = list.child(0).attrs.id as string
    const table = doc.child(4).attrs.id as string
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [
      { op: 'insert_after', anchor_id: item, markdown: '- 插入项' },
      { op: 'table_set_cells', id: table, cells: [{ row: 1, col: 1, markdown: '**0.75**' }] },
      { op: 'table_insert_rows', id: table, at: 2, rows: [['LVEF', '35%']] },
    ] }, { actor: 'ai', turnId: null })
    const after = docs.get(docId)
    expect(after.child(3).childCount).toBe(3)
    expect(after.child(3).child(1).textContent).toBe('插入项')
    expect(after.child(4).childCount).toBe(3)
    expect(after.child(4).textContent).toContain('0.75')
  })

  it('结构守卫：不能在列表项后插入标题', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const item = docs.get(docId).child(3).child(0).attrs.id as string
    expectOpError(() => ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'insert_after', anchor_id: item, markdown: '# 标题' }] }, { actor: 'ai', turnId: null }), 'invalid_structure')
  })
})

describe('守卫', () => {
  it('冲突：用户在 base_rev 之后改过的块，AI 不能改；用户改不受限', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const [, p1, , p2] = ids(docs, docId)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p1!, find: '常见', replace: '少见' }] }, { actor: 'user', turnId: null })
    const e = expectOpError(() => ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p1!, find: '常见', replace: '高发' }] }, { actor: 'ai', turnId: null }), 'conflict_user_edited')
    expect(JSON.stringify(e.extra.current)).toContain('少见')
    // 别的块不受影响；用新 rev 后可以改
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id: p2!, markdown: '- 改写项' }] }, { actor: 'ai', turnId: null })
    ops.edit({ doc_id: docId, base_rev: 2, mode: 'apply', ops: [{ op: 'replace_text', id: p1!, find: '少见', replace: '高发' }] }, { actor: 'ai', turnId: null })
    expect(docs.get(docId).textContent).toContain('高发')
  })

  it('引用：DOI、手写参考文献、未登记的 cite_id 被拒绝', () => {
    const { store, docs, ops, docId } = setup(SAMPLE)
    const [, p1] = ids(docs, docId)
    const edit = (markdown: string) => () => ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'insert_after', anchor_id: p1!, markdown }] }, { actor: 'ai', turnId: null })
    expectOpError(edit('见 doi:10.1056/NEJMoa1409077。'), 'citation_not_registered')
    expectOpError(edit('1. McMurray JJ, Packer M, et al. Angiotensin-neprilysin inhibition. N Engl J Med. 2014;371:993-1004.'), 'citation_not_registered')
    expectOpError(edit('见文献[@c:cnotreal]。'), 'citation_unknown')
    const c = store.upsertCitation({ doc_id: docId, doi: '10.1056/nejmoa1409077', pmid: null, formatted: 'McMurray JJ. ...', url: null })
    edit(`PARADIGM-HF 显示获益[@c:${c.id}]。`)()
    expect(exportMarkdown(docs.get(docId), store.listCitations(docId))).toContain('获益[1]')
  })

  it('锚点：会移除 open 评论锚点的修改需要 ack', () => {
    const { store, docs, ops, docId } = setup(SAMPLE)
    const [, p1] = ids(docs, docId)
    const comment = store.addComment({ doc_id: docId, node_id: p1!, snippet: '常见' })
    const anchored = attachComment(docs.get(docId), p1!, '常见', comment.id)
    docs.commit(docId, anchored.doc, { actor: 'user', turnId: null, ops: [] })
    store.addReply(comment.id, 'user', '这里改成具体发病率')
    // 在被评论文字内部替换：锚点保留，允许
    ops.edit({ doc_id: docId, base_rev: 1, mode: 'apply', ops: [{ op: 'replace_text', id: p1!, find: '常见', replace: '约 2% 成人罹患的' }] }, { actor: 'ai', turnId: null })
    // 匹配跨出评论范围：锚点精确落回被锚定的文字，不随替换扩张
    ops.edit({ doc_id: docId, base_rev: 2, mode: 'apply', ops: [{ op: 'replace_text', id: p1!, find: '罹患的疾病', replace: '罹患的慢性病' }] }, { actor: 'ai', turnId: null })
    const anchoredText = [...docs.get(docId).child(1).content.content].filter(n => n.marks.some(m => m.type.name === 'comment')).map(n => n.text).join('')
    expect(anchoredText).toBe('约 2% 成人罹患的')
    // 删除整段：锚点消失，必须 ack
    expectOpError(() => ops.edit({ doc_id: docId, base_rev: 3, mode: 'apply', ops: [{ op: 'delete', ids: [p1!] }] }, { actor: 'ai', turnId: null }), 'anchor_has_open_comments')
    ops.edit({ doc_id: docId, base_rev: 3, mode: 'apply', ack_comments: [comment.id], ops: [{ op: 'delete', ids: [p1!] }] }, { actor: 'ai', turnId: null })
  })
})

describe('锚点跟随替换', () => {
  function withComment(text: string, snippet: string) {
    const env = setup(text)
    const [p1] = ids(env.docs, env.docId)
    const c = env.store.addComment({ doc_id: env.docId, node_id: p1!, snippet })
    env.docs.commit(env.docId, attachComment(env.docs.get(env.docId), p1!, snippet, c.id).doc, { actor: 'user', turnId: null, ops: [] })
    const anchored = () => [...env.docs.get(env.docId).child(0).content.content].filter(n => n.marks.some(m => m.type.name === 'comment')).map(n => n.text).join('')
    return { ...env, p1: p1!, anchored }
  }

  it('保留原文再补充：锚点精确保留，无需 ack', () => {
    const t = withComment('司美格鲁肽是 GLP-1 受体激动剂。', 'GLP-1 受体激动剂')
    t.ops.edit({ doc_id: t.docId, base_rev: 1, mode: 'apply', ops: [{ op: 'replace_text', id: t.p1, find: 'GLP-1 受体激动剂。', replace: 'GLP-1 受体激动剂，每周皮下注射一次。' }] }, { actor: 'ai', turnId: null })
    expect(t.anchored()).toBe('GLP-1 受体激动剂')
  })

  it('被锚定的文字整体改写：锚点跟到新文字', () => {
    const t = withComment('心衰很常见。', '很常见')
    t.ops.edit({ doc_id: t.docId, base_rev: 1, mode: 'apply', ops: [{ op: 'replace_text', id: t.p1, find: '很常见。', replace: '约影响 2% 的成人。' }] }, { actor: 'ai', turnId: null })
    expect(t.anchored()).toBe('约影响 2% 的成人。')
  })
})

describe('读视图', () => {
  it('outline 与 read 带 rev 和块 id', () => {
    const { docs, store, docId } = setup(SAMPLE)
    const doc = docs.get(docId)
    const o = outline({ doc, docId, title: '测试', rev: 0, citations: [], openComments: 0 })
    expect(o).toContain('rev=0')
    expect(o).toMatch(/# \{#[a-z0-9]+\} 引言/)
    const h2 = doc.child(2).attrs.id as string
    const r = read({ doc, docId, rev: 0, comments: store.listComments(docId), section_id: h2 })
    expect(r).toContain('## 方法')
    expect(r).not.toContain('心力衰竭')
  })
})

describe('replace_text 跨引用标记', () => {
  it('find 跳过了引用标记、replace 只是追加：保留引用，只插入追加的部分', () => {
    const { store, docs, ops, docId } = setup('占位。')
    const c = store.upsertCitation({ doc_id: docId, doi: '10.1056/x', pmid: null, formatted: 'x', url: null })
    const [p] = ids(docs, docId)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id: p!, markdown: `HR 0.80（95% CI 0.72–0.90）[@c:${c.id}]。` }] }, { actor: 'user', turnId: null })
    ops.edit({ doc_id: docId, base_rev: 1, mode: 'apply', ops: [{ op: 'replace_text', id: p!, find: '0.72–0.90）。', replace: '0.72–0.90）。局限：随访较短。' }] }, { actor: 'ai', turnId: null })
    const node = docs.get(docId).child(0)
    expect(node.textContent).toBe('HR 0.80（95% CI 0.72–0.90）。局限：随访较短。')
    let cites = 0
    node.forEach(n => { if (n.type.name === 'citation') cites++ })
    expect(cites).toBe(1)
  })

  it('真正的改写跨过引用：拒绝并提示原样写出引用标记', () => {
    const { store, docs, ops, docId } = setup('占位。')
    const c = store.upsertCitation({ doc_id: docId, doi: '10.1056/x', pmid: null, formatted: 'x', url: null })
    const [p] = ids(docs, docId)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id: p!, markdown: `风险降低[@c:${c.id}]。` }] }, { actor: 'user', turnId: null })
    const e = expectOpError(() => ops.edit({ doc_id: docId, base_rev: 1, mode: 'apply', ops: [{ op: 'replace_text', id: p!, find: '风险降低。', replace: '风险显著降低。' }] }, { actor: 'ai', turnId: null }), 'text_not_found')
    expect(e.extra.hint).toContain('引用标记')
  })
})
