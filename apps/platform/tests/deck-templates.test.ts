import { DOMParser } from '@xmldom/xmldom'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { Node as PMNode } from 'prosemirror-model'
import { describe, expect, it } from 'vitest'
import { pptxFor } from '../src/convert/exports.ts'
import { importPptx } from '../src/convert/pptx-import.ts'
import { readLayouts } from '../src/convert/pptx-layouts.ts'
import { isPlatformPackage, pptxTemplate } from '../src/convert/pptx-template.ts'
import { deckSchema, emu, pt } from '../src/model/deck-schema.ts'
import { decorations, isDecoName, LAYOUTS, layoutSpec, templateCatalog } from '../src/model/deck-templates.ts'
import { DECK_THEMES } from '../src/model/deck-themes.ts'
import { Documents } from '../src/model/runtime.ts'
import { newTemplateDeck, type DeckOp } from '../src/ops/deck.ts'
import { OpService } from '../src/ops/service.ts'
import { OpError } from '../src/ops/types.ts'
import { Store } from '../src/store/db.ts'
import { deckOutline, slideRead } from '../src/views/deck.ts'
import { checkLayout } from '../src/views/layout.ts'

function deck(template = 'clinical', content?: PMNode, pkg?: Uint8Array) {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const row = docs.create({ owner: 'u', title: '汇报', kind: 'deck', content: content ?? newTemplateDeck('SELECT 试验', template) })
  store.putPackage(row.id, 'pptx', pkg ?? pptxTemplate(template))
  const edit = (list: DeckOp[]) => ops.edit({ doc_id: row.id, base_rev: docs.rev(row.id), mode: 'apply', ops: list }, { actor: 'ai', turnId: null })
  const doc = () => docs.get(row.id)
  const shapes = (i: number) => { const out: PMNode[] = []; doc().child(i).forEach(s => { if (s.type.name === 'shape') out.push(s) }); return out }
  return { store, docs, ops, docId: row.id, edit, doc, shapes }
}

const wellFormed = (xml: string) => {
  const errors: string[] = []
  new DOMParser({ onError: (level, msg) => { if (level !== 'warning') errors.push(msg) } }).parseFromString(xml, 'text/xml')
  return errors
}

const decoNames = (shapes: PMNode[]) => shapes.filter(s => isDecoName(s.attrs.name)).map(s => s.attrs.name as string)

describe('deck 模板：每套模板 × 每个版式', () => {
  it('8 个以上模板；每个模板的每个版式都能生成，占位符在页面内、装饰在最底层', () => {
    expect(Object.keys(DECK_THEMES).length).toBeGreaterThanOrEqual(8)
    for (const key of Object.keys(DECK_THEMES)) {
      const t = deck(key)
      let after = t.doc().child(0).attrs.id as string
      for (const l of LAYOUTS) {
        const r = t.edit([{ op: 'add_slide', after, layout: l.name, title: `${l.name}标题`, body: l.key === 'big_number' ? '87%' : '- 要点一\n- 要点二', body2: '右栏或说明' }])
        after = r.results[0]!.ids[0]!
      }
      t.doc().check()
      expect(t.doc().childCount).toBe(LAYOUTS.length + 1)
      t.doc().forEach((slide, _o, i) => {
        expect([key, slide.attrs.theme, slide.attrs.bg]).toEqual([key, key, DECK_THEMES[key]!.bg])
        const list = t.shapes(i)
        // 装饰在文字占位符下面
        const firstText = list.findIndex(s => !isDecoName(s.attrs.name))
        if (firstText >= 0) expect(list.slice(firstText).some(s => isDecoName(s.attrs.name))).toBe(false)
        for (const s of list.filter(s => s.attrs.ph)) {
          expect(pt(s.attrs.x) >= 0 && pt(s.attrs.y) >= 0 && pt(s.attrs.x + s.attrs.w) <= 960 && pt(s.attrs.y + s.attrs.h) <= 540).toBe(true)
        }
      })
      // 版面检查不把装饰（可以出血到页外）当问题；文字也不溢出
      expect([key, checkLayout(t.doc(), { cx: 12192000, cy: 6858000 }).filter(i => i.kind !== 'small_font')]).toEqual([key, []])
    }
  })

  it('版式把 title / body / body2 填进对的占位符，样式按版式（大数字加粗用强调色、两栏右栏、说明无项目符号）', () => {
    const t = deck('coral')
    const first = t.doc().child(0).attrs.id as string
    t.edit([
      { op: 'add_slide', after: first, layout: '大数字', title: '主要终点', body: '20%', body2: '心血管死亡相对风险下降' },
      { op: 'add_slide', after: first, layout: '两栏', title: '对比', body: '- 司美格鲁肽', body2: '- 安慰剂' },
    ])
    const big = t.shapes(2).filter(s => s.attrs.ph === 'body')
    expect(big.map(s => s.textContent)).toEqual(['20%', '心血管死亡相对风险下降'])
    const number = big[0]!.firstChild!.firstChild!
    expect(number.marks.some(m => m.type.name === 'bold')).toBe(true)
    expect(number.marks.find(m => m.type.name === 'rpr')!.attrs.xml).toContain(DECK_THEMES.coral!.accent)
    expect(String(big[1]!.firstChild!.attrs.ppr)).toContain('<a:buNone/>')
    const cols = t.shapes(1).filter(s => s.attrs.ph === 'body')
    expect(cols.map(s => [s.attrs.ph_idx, s.textContent])).toEqual([['1', '司美格鲁肽'], ['2', '安慰剂']])
    // 英文名、旧名也认；不存在的版式给出可用版式
    t.edit([{ op: 'add_slide', after: first, layout: 'Section Header', title: '第二部分' }])
    expect(t.doc().child(1).attrs.layout_name).toBe('章节页')
    try { t.edit([{ op: 'add_slide', after: first, layout: '时间线' }]); throw new Error('应当拒绝') } catch (err) {
      expect((err as OpError).code).toBe('layout_not_found')
      expect((err as OpError).extra.hint).toContain('大数字')
    }
  })

  it('空占位符后来写字：沿用版式的字号、颜色、粗细', () => {
    const t = deck('swiss')
    const first = t.doc().child(0).attrs.id as string
    const ids = t.edit([{ op: 'add_slide', after: first, layout: '大数字' }]).results[0]!.ids
    const number = t.shapes(1).find(s => s.attrs.ph === 'body' && s.attrs.ph_idx === '1')!
    expect(ids).toContain(number.attrs.id)
    t.edit([{ op: 'set_text', shape_id: number.attrs.id as string, markdown: '17,604' }])
    const run = t.shapes(1).find(s => s.attrs.id === number.attrs.id)!.firstChild!.firstChild!
    expect(run.marks.some(m => m.type.name === 'bold')).toBe(true)
    expect(run.marks.find(m => m.type.name === 'rpr')!.attrs.xml).toMatch(/sz="9600"[\s\S]*DC2626/)
  })
})

describe('换模板', () => {
  it('只换装饰与颜色：用户形状、文字不动；继承版式位置的占位符挪到新模板位置，拖动过的不动', () => {
    const t = deck('clinical')
    const first = t.doc().child(0).attrs.id as string
    const content = t.edit([{ op: 'add_slide', after: first, layout: '标题和内容', title: '研究设计', body: '- 多中心随机双盲' }]).results[0]!.ids[0]!
    const block = t.edit([{ op: 'add_shape', slide_id: content, markdown: '自定义', x: 600, y: 300, w: 200, h: 80, geometry: 'roundRect', fill: '7C3AED' }]).results[0]!.ids[0]!
    const subtitle = t.shapes(0).find(s => s.attrs.ph === 'subTitle')!.attrs.id as string
    t.edit([{ op: 'set_xfrm', shape_id: subtitle, x: 100, y: 420 }])
    const before = t.shapes(1).filter(s => !isDecoName(s.attrs.name)).map(s => [s.attrs.id, s.textContent])

    t.edit([{ op: 'apply_theme', theme: 'coral' }])
    expect(decoNames(t.shapes(0))).toEqual(decorations('coral', 'cover').map(d => d.name))
    expect(decoNames(t.shapes(1))).toEqual(decorations('coral', 'content').map(d => d.name))
    expect(decoNames(t.shapes(1)).some(n => n.startsWith('deco:clinical'))).toBe(false)
    expect(t.shapes(1).filter(s => !isDecoName(s.attrs.name)).map(s => [s.attrs.id, s.textContent])).toEqual(before)
    // 用户自己的色块（非主题色）不变
    expect(t.shapes(1).find(s => s.attrs.id === block)!.attrs).toMatchObject({ fill: '7C3AED', x: emu(600) })
    // 封面标题挪到珊瑚模板为色块让出的位置；拖动过的副标题不动
    const coverTitle = layoutSpec('coral', 'cover').find(s => s.type === 'ctrTitle')!
    expect(t.shapes(0).find(s => s.attrs.ph === 'ctrTitle')!.attrs.w).toBe(emu(coverTitle.box[2]))
    expect(t.shapes(0).find(s => s.attrs.id === subtitle)!.attrs).toMatchObject({ x: emu(100), y: emu(420) })
    // 文字颜色按新模板
    expect(t.shapes(1).find(s => s.attrs.ph === 'title')!.firstChild!.firstChild!.marks.find(m => m.type.name === 'rpr')!.attrs.xml).toContain(DECK_THEMES.coral!.title)
    // 居中模板：封面标题居中
    t.edit([{ op: 'apply_theme', theme: 'paper' }])
    expect(t.shapes(0).find(s => s.attrs.ph === 'ctrTitle')!.firstChild!.attrs.align).toBe('center')
  })

  it('模板装饰不能写字，可以删除；AI 读到的装饰合成一行', () => {
    const t = deck('mint')
    const deco = t.shapes(0).find(s => isDecoName(s.attrs.name))!.attrs.id as string
    try { t.edit([{ op: 'set_text', shape_id: deco, markdown: '字' }]); throw new Error('应当拒绝') } catch (err) {
      expect((err as OpError).code).toBe('node_not_editable')
    }
    const read = slideRead(t.doc().child(0), 0, t.docs.rev(t.docId))
    expect(read).toMatch(/模板装饰 3 个/)
    t.edit([{ op: 'delete_shape', shape_id: deco }])
    expect(decoNames(t.shapes(0))).toHaveLength(2)
  })

  it('导入的 pptx（不是平台模板）换配色时不加装饰', () => {
    const imported = importPptx(pptxWithSlide())
    const t = deck('clinical', imported.doc, pptxWithSlide())
    expect(t.ops.deckContextInfo(t.docId).platform).toBe(false)
    t.edit([{ op: 'apply_theme', theme: 'swiss' }])
    expect(decoNames(t.shapes(0))).toEqual([])
    expect(t.doc().child(0).attrs.theme).toBe('swiss')
  })
})

describe('早期 deck 兼容（只有 3 个版式的平台包）', () => {
  it('能读、能加新版式的页、能换模板（英文版式名换成模板版式名）、能导出', () => {
    const old = oldPackage()
    expect(isPlatformPackage(old)).toBe(true)
    const content = deckSchema.node('doc', null, [
      deckSchema.node('slide', { layout: 'ppt/slideLayouts/slideLayout1.xml', layout_name: 'Title Slide' }, [
        deckSchema.node('shape', { kind: 'text', ph: 'ctrTitle', x: 1524000, y: 1122363, w: 9144000, h: 2387600, xfrm_inherited: true, name: 'Title' }, [deckSchema.node('paragraph', null, [deckSchema.text('旧汇报')])]),
      ]),
      deckSchema.node('slide', { layout: 'ppt/slideLayouts/slideLayout2.xml', layout_name: 'Title and Content' }, [
        deckSchema.node('shape', { kind: 'text', ph: 'title', x: 838200, y: 365125, w: 10515600, h: 1325563, xfrm_inherited: true, name: 'Title' }, [deckSchema.node('paragraph', null, [deckSchema.text('背景')])]),
      ]),
    ])
    const t = deck('clinical', content, old)
    const info = t.ops.deckContextInfo(t.docId)
    expect(info.platform).toBe(true)
    expect(deckOutline({ doc: t.doc(), docId: t.docId, title: '旧', rev: 0, layouts: info.layouts as never, size: info.size, openComments: 0, platform: true })).toContain('两栏（')
    // 没套过模板的旧 deck：新页不带装饰，旧页不受影响
    t.edit([{ op: 'add_slide', after: t.doc().child(1).attrs.id as string, layout: 'Title and Content', title: '方法', body: '- 回顾性队列' }])
    expect(t.doc().child(2).attrs.layout_name).toBe('标题和内容')
    expect(decoNames(t.shapes(2))).toEqual([])
    t.edit([{ op: 'apply_theme', theme: 'teal' }])
    expect([0, 1, 2].map(i => t.doc().child(i).attrs.layout_name)).toEqual(['封面', '标题和内容', '标题和内容'])
    expect(t.shapes(0).find(s => s.attrs.ph === 'ctrTitle')!.attrs.x).toBe(emu(layoutSpec('teal', 'cover')[0]!.box[0]))
    expect(decoNames(t.shapes(1)).length).toBeGreaterThan(0)
    // 导出：按模板重新生成底座，8 个版式都在
    const bytes = pptxFor(t.docs, t.docId).bytes
    expect(readLayouts(bytes).layouts).toHaveLength(8)
    expect(importPptx(bytes).doc.childCount).toBe(3)
  })
})

describe('导出与重新导入', () => {
  it('每套模板导出的 pptx 结构完整、XML 良构；重新导入后页数、版式名、装饰都在', () => {
    for (const key of Object.keys(DECK_THEMES)) {
      const t = deck(key)
      let after = t.doc().child(0).attrs.id as string
      for (const l of LAYOUTS.slice(1)) after = t.edit([{ op: 'add_slide', after, layout: l.name, title: l.name, body: '- 一\n- 二', body2: '说明' }]).results[0]!.ids[0]!
      const bytes = pptxFor(t.docs, t.docId).bytes
      const files = unzipSync(bytes)
      for (const [name, data] of Object.entries(files)) if (/\.xml$|\.rels$/.test(name)) expect([name, wellFormed(strFromU8(data))]).toEqual([name, []])
      expect(strFromU8(files['ppt/theme/theme1.xml']!)).toContain(`<a:accent1><a:srgbClr val="${DECK_THEMES[key]!.accent}"/>`)
      const back = importPptx(bytes)
      expect(back.doc.childCount).toBe(LAYOUTS.length)
      const names: string[] = []
      back.doc.forEach(s => names.push(s.attrs.layout_name as string))
      expect(names).toEqual(LAYOUTS.map(l => l.name))
      let decos = 0
      back.doc.descendants(n => { if (n.type.name === 'shape' && isDecoName(n.attrs.name)) decos++; return n.type.name !== 'shape' })
      expect(decos).toBeGreaterThan(0)
    }
  })

  it('模板清单：每个模板都有说明、版式、预览用的占位符与装饰', () => {
    const catalog = templateCatalog()
    expect(catalog.map(c => c.key)).toEqual(Object.keys(DECK_THEMES))
    for (const c of catalog) {
      expect(c.description.length).toBeGreaterThan(8)
      expect(c.layouts.map(l => l.name)).toEqual(LAYOUTS.map(l => l.name))
      expect(c.layouts.find(l => l.key === 'cover')!.placeholders.length).toBe(2)
    }
  })
})

/** 一页的普通 pptx（不是平台模板生成的）。 */
function pptxWithSlide(): Uint8Array {
  const files = unzipSync(pptxTemplate())
  const theme = strFromU8(files['ppt/theme/theme1.xml']!).replace(/name="Heurion"/g, 'name="Office Theme"')
  files['ppt/theme/theme1.xml'] = strToU8(theme)
  const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
  files['ppt/slides/slide1.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN"/><a:t>外部文件</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`)
  files['ppt/slides/_rels/slide1.xml.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout2.xml"/></Relationships>')
  const pres = strFromU8(files['ppt/presentation.xml']!).replace('<p:sldIdLst/>', '<p:sldIdLst><p:sldId id="256" r:id="rId9"/></p:sldIdLst>')
  files['ppt/presentation.xml'] = strToU8(pres)
  files['ppt/_rels/presentation.xml.rels'] = strToU8(strFromU8(files['ppt/_rels/presentation.xml.rels']!).replace('</Relationships>', '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'))
  files['[Content_Types].xml'] = strToU8(strFromU8(files['[Content_Types].xml']!).replace('</Types>', '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'))
  return zipSync(files)
}

/** 早期平台模板的包：只有 3 个英文名版式。 */
function oldPackage(): Uint8Array {
  const files = unzipSync(pptxTemplate())
  for (const n of [4, 5, 6, 7, 8]) { delete files[`ppt/slideLayouts/slideLayout${n}.xml`]; delete files[`ppt/slideLayouts/_rels/slideLayout${n}.xml.rels`] }
  for (const [n, name] of [[1, 'Title Slide'], [2, 'Title and Content'], [3, 'Blank']] as const) {
    files[`ppt/slideLayouts/slideLayout${n}.xml`] = strToU8(strFromU8(files[`ppt/slideLayouts/slideLayout${n}.xml`]!).replace(/<p:cSld name="[^"]*"/, `<p:cSld name="${name}"`))
  }
  return zipSync(files)
}
