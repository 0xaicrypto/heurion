import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { exportDocx } from '../src/convert/docx-export.ts'
import { bindAssets, importDocx } from '../src/convert/docx-import.ts'
import { attachComment } from '../src/model/anchors.ts'
import { parseBlocks } from '../src/model/markdown.ts'
import { Documents } from '../src/model/runtime.ts'
import { schema } from '../src/model/schema.ts'
import { OpService } from '../src/ops/service.ts'
import { Store } from '../src/store/db.ts'
import { docx, drawing, IMAGE_REL, li, p, PNG } from './fixtures.ts'

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

describe('docx 导出：图、不可编辑段落、列表样式', () => {
  const withImage = (body: string) => docx(body, { rels: IMAGE_REL, files: { 'word/media/image1.png': PNG } })
  const drawings = (bytes: Uint8Array) => (bodyOf(bytes).match(/<w:drawing>/g) ?? []).length

  it('文字与图混排的段落：原样写回时图不重复；改了文字后图仍只出现一次', () => {
    const original = withImage(`${p('前文')}<w:p><w:r><w:t>见下图</w:t></w:r>${drawing()}</w:p>${p('后文')}`)
    const t = importInto(original)
    expect(bodyOf(t.exportNow().bytes)).toBe(bodyOf(original))
    const para = t.docs.get(t.docId).child(1).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: para, find: '见下图', replace: '见图 1' }] }, { actor: 'user', turnId: null })
    const out = t.exportNow().bytes
    expect(drawings(out)).toBe(1)
    expect(bodyOf(out)).toContain('见图 1')
  })

  it('只有一张图的段落：未改动时逐字节写回', () => {
    const original = withImage(`${p('前文')}<w:p>${drawing()}</w:p>`)
    const t = importInto(original)
    expect(t.docs.get(t.docId).child(1).type.name).toBe('figure')
    expect(bodyOf(t.exportNow().bytes)).toBe(bodyOf(original))
  })

  it('含文本框 / 脚注的段落导入为不可编辑块，导出原样保留', () => {
    const textbox = `<w:p><w:r><w:t>正文</w:t></w:r><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps"><w:t>框内文字</w:t></mc:Choice></mc:AlternateContent></w:r></w:p>`
    const footnote = `<w:p><w:r><w:t>有脚注</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>`
    const r = importDocx(docx(textbox + footnote))
    expect(r.doc.child(0).type.name).toBe('opaque')
    expect(r.doc.child(1).attrs.kind).toBe('脚注')
    expect(r.warnings.join()).toContain('不可编辑块')
    const t = importInto(docx(textbox + footnote + p('可编辑')))
    const last = t.docs.get(t.docId).child(2).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: last, find: '可编辑', replace: '已编辑' }] }, { actor: 'user', turnId: null })
    const body = bodyOf(t.exportNow().bytes)
    expect(body).toContain('框内文字')
    expect(body).toContain('<w:footnoteReference w:id="1"/>')
  })

  it('新建的无序列表沿用原文件无序列表的编号定义与段落样式', () => {
    const bullet = (t: string) => p(t, '<w:pStyle w:val="ListBullet"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr>')
    const original = docx(`${bullet('原有项')}${p('正文')}`)
    // numId 7 → abstractNum 3（bullet）
    const files = unzipSync(original)
    files['word/numbering.xml'] = strToU8(`<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="3"/></w:num></w:numbering>`)
    const t = importInto(zipSync(files))
    const para = t.docs.get(t.docId).child(1).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'insert_after', anchor_id: para, markdown: '- 新项' }] }, { actor: 'user', turnId: null })
    const out = unzipSync(t.exportNow().bytes)
    const numbering = strFromU8(out['word/numbering.xml']!)
    expect(numbering).toMatch(/<w:num w:numId="9001"><w:abstractNumId w:val="3"\/>/)
    expect(numbering).not.toContain('w:abstractNumId="9001"')
    expect(bodyOf(t.exportNow().bytes)).toMatch(/<w:pStyle w:val="ListBullet"\/><w:numPr><w:ilvl w:val="0"\/><w:numId w:val="9001"\/>/)
  })
})
