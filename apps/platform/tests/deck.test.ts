import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { exportPptx } from '../src/convert/pptx-export.ts'
import { bindDeckAssets, importPptx } from '../src/convert/pptx-import.ts'
import { readLayouts } from '../src/convert/pptx-layouts.ts'
import { pptxTemplate } from '../src/convert/pptx-template.ts'
import { Documents } from '../src/model/runtime.ts'
import { newDeckContent } from '../src/ops/deck.ts'
import { OpService } from '../src/ops/service.ts'
import { OpError } from '../src/ops/types.ts'
import { Store } from '../src/store/db.ts'
import { deckOutline, slideRead } from '../src/views/deck.ts'

function newDeck() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const pkg = pptxTemplate()
  const { layouts } = readLayouts(pkg)
  const row = docs.create({ owner: 'u', title: '汇报', kind: 'deck', content: newDeckContent(layouts, 'SELECT 试验') })
  store.putPackage(row.id, 'pptx', pkg)
  const exportNow = (baselineSeq: number | null = null) => exportPptx({
    doc: docs.get(row.id), baseline: baselineSeq ? docs.versionDoc(row.id, baselineSeq) : null, pkg: store.getPackage(row.id)!,
    src: id => store.getNodeSrc(row.id, id), citations: store.listCitations(row.id),
  })
  return { store, docs, ops, docId: row.id, layouts, exportNow }
}

const slideIds = (t: ReturnType<typeof newDeck>) => { const out: string[] = []; t.docs.get(t.docId).forEach(s => out.push(s.attrs.id as string)); return out }
const shapesOf = (t: ReturnType<typeof newDeck>, i: number) => { const out: Array<{ id: string; ph: string | null; text: string }> = []; t.docs.get(t.docId).child(i).forEach(s => { if (s.type.name === 'shape') out.push({ id: s.attrs.id as string, ph: s.attrs.ph as string | null, text: s.textContent }) }); return out }

describe('deck：模型与编辑', () => {
  it('新建 deck → add_slide / set_text / replace_text / add_shape / set_xfrm / notes / move → 导出 → 回读一致', () => {
    const t = newDeck()
    expect(deckOutline({ doc: t.docs.get(t.docId), docId: t.docId, title: '汇报', rev: 0, layouts: t.layouts, size: { cx: 12192000, cy: 6858000 }, openComments: 0 })).toContain('SELECT 试验')
    const [first] = slideIds(t)
    const r = t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [
      { op: 'add_slide', after: first!, layout: 'Title and Content', title: '研究设计', body: '- 多中心随机双盲\n- 17,604 例\n  - 无糖尿病' },
      { op: 'set_text', shape_id: shapesOf(t, 0).find(s => s.ph === 'subTitle')!.id, markdown: '心血管结局试验解读' },
    ] }, { actor: 'ai', turnId: null })
    const added = r.results[0]!.ids[0]!
    expect(slideIds(t)).toEqual([first, added])
    const body = shapesOf(t, 1).find(s => s.ph === 'body')!
    t.ops.edit({ doc_id: t.docId, base_rev: 1, mode: 'apply', ops: [
      { op: 'replace_text', shape_id: body.id, find: '17,604 例', replace: '17,604 例受试者' },
      { op: 'add_shape', slide_id: added, markdown: '数据来源：NEJM 2023', x: 40, y: 480, w: 400, h: 30, font_size: 12 },
      { op: 'set_notes', slide_id: added, markdown: '强调无糖尿病人群' },
      { op: 'move_slide', slide_id: added, after: null },
    ] }, { actor: 'ai', turnId: null })
    expect(slideIds(t)[0]).toBe(added)
    const read = slideRead(t.docs.get(t.docId).child(0), 0, 2)
    expect(read).toContain('17,604 例受试者')
    expect(read).toContain('  - 无糖尿病')
    expect(read).toContain('备注：强调无糖尿病人群')

    const out = t.exportNow()
    const back = importPptx(out.bytes)
    expect(back.doc.childCount).toBe(2)
    const s0 = back.doc.child(0)
    const texts: string[] = []
    s0.forEach(s => texts.push(s.textContent))
    expect(texts.join('|')).toContain('研究设计')
    expect(texts.join('|')).toContain('17,604 例受试者')
    expect(texts.join('|')).toContain('数据来源：NEJM 2023')
    let lvls: number[] = []
    s0.forEach(s => { if (s.attrs.ph === 'obj' || s.attrs.ph === 'body') s.forEach(p => lvls.push(p.attrs.lvl as number)) })
    expect(lvls).toEqual([0, 0, 1])
    expect(back.doc.child(1).textContent).toContain('心血管结局试验解读')
  })

  it('导入后不改：每页 XML 逐字节写回；改一页只动那一页', () => {
    const t = newDeck()
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'add_slide', after: slideIds(t)[0]!, title: '第二页', body: '- 要点' }] }, { actor: 'ai', turnId: null })
    const original = t.exportNow().bytes
    // 以导出的文件为「上传的 pptx」重新导入
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const ops = new OpService(docs)
    const imported = importPptx(original)
    const row = docs.create({ owner: 'u', title: 'x', kind: 'deck', content: bindDeckAssets(imported.doc, new Map()), source: 'import' })
    store.putNodeSrc(row.id, imported.src)
    store.putPackage(row.id, 'pptx', original)
    const exp = () => unzipSync(exportPptx({ doc: docs.get(row.id), baseline: docs.versionDoc(row.id, 1), pkg: original, src: id => store.getNodeSrc(row.id, id), citations: [] }).bytes)
    const before = unzipSync(original)
    let after = exp()
    for (const f of ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/presentation.xml']) expect(strFromU8(after[f]!)).toBe(strFromU8(before[f]!))
    const s2 = docs.get(row.id).child(1)
    let title = ''
    s2.forEach(s => { if (s.attrs.ph === 'title') title = s.attrs.id as string })
    ops.edit({ doc_id: row.id, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', shape_id: title, find: '第二页', replace: '研究结果' }] }, { actor: 'user', turnId: null })
    after = exp()
    expect(strFromU8(after['ppt/slides/slide1.xml']!)).toBe(strFromU8(before['ppt/slides/slide1.xml']!))
    expect(strFromU8(after['ppt/slides/slide2.xml']!)).toContain('研究结果')
    expect(strFromU8(after['ppt/slides/slide2.xml']!)).toContain('要点')
  })

  it('删页与守卫：引用守卫、冲突守卫、不可编辑形状', () => {
    const t = newDeck()
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'add_slide', after: slideIds(t)[0]!, title: 'A', body: '- B' }] }, { actor: 'ai', turnId: null })
    const body = shapesOf(t, 1).find(s => s.ph === 'body')!.id
    const code = (fn: () => unknown) => { try { fn() } catch (e) { return (e as OpError).code } return 'ok' }
    expect(code(() => t.ops.edit({ doc_id: t.docId, base_rev: 1, mode: 'apply', ops: [{ op: 'set_text', shape_id: body, markdown: '见 doi:10.1056/NEJMoa2307563' }] }, { actor: 'ai', turnId: null }))).toBe('citation_not_registered')
    t.ops.edit({ doc_id: t.docId, base_rev: 1, mode: 'apply', ops: [{ op: 'replace_text', shape_id: body, find: 'B', replace: 'B（用户改）' }] }, { actor: 'user', turnId: null })
    expect(code(() => t.ops.edit({ doc_id: t.docId, base_rev: 1, mode: 'apply', ops: [{ op: 'set_text', shape_id: body, markdown: 'AI 覆盖' }] }, { actor: 'ai', turnId: null }))).toBe('conflict_user_edited')
    t.ops.edit({ doc_id: t.docId, base_rev: 2, mode: 'apply', ops: [{ op: 'delete_slide', slide_id: slideIds(t)[0]! }] }, { actor: 'ai', turnId: null })
    expect(slideIds(t)).toHaveLength(1)
    const out = unzipSync(t.exportNow().bytes)
    expect(Object.keys(out).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))).toHaveLength(1)
    expect(strFromU8(out['ppt/presentation.xml']!).match(/<p:sldId\b/g)).toHaveLength(1)
  })
})

describe('deck：导出 XML 结构', () => {
  it('带子元素的 bodyPr / lstStyle 在修补时保持完整，导出的每页 XML 格式良好', async () => {
    const { DOMParser } = await import('@xmldom/xmldom')
    const t = newDeck()
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'add_slide', after: slideIds(t)[0]!, title: 'T', body: '- 一' }] }, { actor: 'ai', turnId: null })
    // 给正文形状换上带子元素的 bodyPr（真实文件常见）后再导出、导入、修改
    const original = t.exportNow().bytes
    const files = unzipSync(original)
    const slide = strFromU8(files['ppt/slides/slide2.xml']!).replace(/<a:bodyPr\/>/g, '<a:bodyPr wrap="square"><a:spAutoFit/></a:bodyPr>').replace(/<a:lstStyle\/>/g, '<a:lstStyle><a:lvl1pPr marL="0"/></a:lstStyle>')
    files['ppt/slides/slide2.xml'] = new TextEncoder().encode(slide)
    const { zipSync } = await import('fflate')
    const pkg = zipSync(files)
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const ops = new OpService(docs)
    const imported = importPptx(pkg)
    const row = docs.create({ owner: 'u', title: 'x', kind: 'deck', content: imported.doc, source: 'import' })
    store.putNodeSrc(row.id, imported.src)
    let body = ''
    docs.get(row.id).child(1).forEach(s => { if (s.attrs.ph === 'body') body = s.attrs.id as string })
    ops.edit({ doc_id: row.id, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', shape_id: body, find: '一', replace: '一（改）' }] }, { actor: 'user', turnId: null })
    const out = unzipSync(exportPptx({ doc: docs.get(row.id), baseline: docs.versionDoc(row.id, 1), pkg, src: id => store.getNodeSrc(row.id, id), citations: [] }).bytes)
    const xml = strFromU8(out['ppt/slides/slide2.xml']!)
    expect(xml).toContain('<a:bodyPr wrap="square"><a:spAutoFit/></a:bodyPr>')
    expect(xml).toContain('<a:lstStyle><a:lvl1pPr marL="0"/></a:lstStyle>')
    expect(xml).toContain('一（改）')
    const errors: string[] = []
    new DOMParser({ onError: (level, msg) => { if (level !== 'warning') errors.push(msg) } }).parseFromString(xml, 'text/xml')
    expect(errors).toEqual([])
  })
})
