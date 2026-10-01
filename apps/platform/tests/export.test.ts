import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { exportDocx } from '../src/convert/docx-export.ts'
import { bindAssets, importDocx } from '../src/convert/docx-import.ts'
import { attachComment } from '../src/model/anchors.ts'
import { parseBlocks } from '../src/model/markdown.ts'
import { Documents } from '../src/model/runtime.ts'
import { schema } from '../src/model/schema.ts'
import { OpService } from '../src/ops/service.ts'
import { Store } from '../src/store/db.ts'
import { docx, li, p } from './fixtures.ts'

/** 模拟 API 的导入流程，返回平台里的文档。 */
function importInto(bytes: Uint8Array) {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const r = importDocx(bytes)
  const ids = new Map(r.assets.map(a => [a.key, store.putAsset({ owner: 'u', mime: a.mime, name: a.name, bytes: a.bytes }).id]))
  const row = docs.create({ owner: 'u', title: 't', content: bindAssets(r.doc, ids), source: 'import' })
  store.putNodeSrc(row.id, r.src)
  store.putPackage(row.id, 'docx', bytes)
  const exportNow = () => exportDocx({
    doc: docs.get(row.id), baseline: docs.versionDoc(row.id, 1), pkg: bytes,
    src: id => store.getNodeSrc(row.id, id), citations: store.listCitations(row.id), comments: store.listComments(row.id),
    asset: id => { const a = store.getAsset(id); return a ? { mime: a.mime, bytes: store.getAssetBytes(id)! } : null },
  })
  return { store, docs, ops, docId: row.id, exportNow }
}

const bodyOf = (bytes: Uint8Array) => {
  const xml = strFromU8(unzipSync(bytes)['word/document.xml']!)
  return xml.slice(xml.indexOf('<w:body>') + 8, xml.indexOf('</w:body>'))
}

const BODY = [
  p('引言', '<w:pStyle w:val="Heading1"/>'),
  p('心衰是常见病。', '', '<w:b/>'),
  li('第一步', 0), li('第二步', 0),
  `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
].join('')

describe('docx 导出（修补式）', () => {
  it('导入后不改：正文逐字节原样写回', () => {
    const original = docx(BODY)
    const t = importInto(original)
    expect(bodyOf(t.exportNow().bytes)).toBe(bodyOf(original))
  })

  it('改一段：只有该段重新生成，其余原样；回读内容一致', () => {
    const original = docx(BODY)
    const t = importInto(original)
    const para = t.docs.get(t.docId).child(1).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [
      { op: 'replace_text', id: para, find: '常见病', replace: '高发病' },
      { op: 'insert_after', anchor_id: t.docs.get(t.docId).child(2).child(1).attrs.id as string, markdown: '- 第三步' },
    ] }, { actor: 'user', turnId: null })
    const out = t.exportNow().bytes
    const body = bodyOf(out)
    expect(body).toContain(p('引言', '<w:pStyle w:val="Heading1"/>'))
    expect(body).not.toContain('常见病')
    expect(body).toContain('<w:b/>') // 替换后保留粗体
    // 新列表项接在原列表的编号上
    expect(body.match(/<w:numId w:val="1"\/>/g)!.length).toBe(3)
    const back = importDocx(out)
    expect(back.doc.textContent).toBe(t.docs.get(t.docId).textContent)
  })

  it('新建文档：标题、列表、表格合并、引用编号、参考文献、评论、图片', () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const ops = new OpService(docs)
    const row = docs.create({ owner: 'u', title: 't', content: schema.node('doc', null, parseBlocks('# 引言\n\n心衰常见。\n\n1. 甲\n2. 乙\n\n| a | b |\n| --- | --- |\n| 1 | 2 |')) })
    const cite = store.upsertCitation({ doc_id: row.id, doi: '10.1056/x', pmid: null, formatted: 'Doe J. Trial. N Engl J Med. 2020.', url: null })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0, 0, 0, 1, 0])
    const asset = store.putAsset({ owner: 'u', mime: 'image/png', name: 'c.png', bytes: png })
    const para = docs.get(row.id).child(1).attrs.id as string
    ops.edit({ doc_id: row.id, base_rev: 0, mode: 'apply', ops: [
      { op: 'replace_text', id: para, find: '常见', replace: `常见[@c:${cite.id}]` },
      { op: 'insert_after', anchor_id: para, markdown: `![发病率](asset:${asset.id} "图 1")` },
    ] }, { actor: 'ai', turnId: null })
    const c = store.addComment({ doc_id: row.id, node_id: para, snippet: '心衰' })
    store.addReply(c.id, 'user', '补充数据')
    docs.commit(row.id, attachComment(docs.get(row.id), para, '心衰', c.id).doc, { actor: 'user', turnId: null, ops: [] })

    const out = exportDocx({
      doc: docs.get(row.id), baseline: null, pkg: null, src: () => null,
      citations: store.listCitations(row.id), comments: store.listComments(row.id),
      asset: id => { const a = store.getAsset(id); return a ? { mime: a.mime, bytes: store.getAssetBytes(id)! } : null },
    })
    const files = unzipSync(out.bytes)
    const body = strFromU8(files['word/document.xml']!)
    expect(body).toContain('<w:pStyle w:val="Heading1"/>')
    expect(body).toContain('[1]')
    expect(body).toContain('Doe J. Trial')
    expect(body).toContain('<w:commentRangeStart')
    expect(strFromU8(files['word/comments.xml']!)).toContain('补充数据')
    expect(files['word/numbering.xml']).toBeDefined()
    expect(Object.keys(files).some(f => f.startsWith('word/media/'))).toBe(true)
    expect(strFromU8(files['[Content_Types].xml']!)).toContain('Extension="png"')
    // 回读：结构保持
    const back = importDocx(out.bytes)
    const kinds: string[] = []
    back.doc.forEach(n => kinds.push(n.type.name))
    expect(kinds.slice(0, 5)).toEqual(['heading', 'paragraph', 'figure', 'ordered_list', 'table'])
    expect(back.doc.child(3).childCount).toBe(2)
  })
})
