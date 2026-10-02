import { DOMParser } from '@xmldom/xmldom'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { checkChartData, readChart } from '../src/convert/pptx-chart.ts'
import { exportPptx } from '../src/convert/pptx-export.ts'
import { importPptx } from '../src/convert/pptx-import.ts'
import { readLayouts } from '../src/convert/pptx-layouts.ts'
import { pptxTemplate } from '../src/convert/pptx-template.ts'
import { Documents } from '../src/model/runtime.ts'
import { DeckOp, newDeckContent } from '../src/ops/deck.ts'
import { OpService } from '../src/ops/service.ts'
import { OpError } from '../src/ops/types.ts'
import { Store } from '../src/store/db.ts'
import { slideRead } from '../src/views/deck.ts'

const wellFormed = (xml: string) => {
  const errors: string[] = []
  new DOMParser({ onError: (level, msg) => { if (level !== 'warning') errors.push(msg) } }).parseFromString(xml, 'text/xml')
  return errors
}

function deckOf(content: ReturnType<typeof newDeckContent>, pkg: Uint8Array, src: Array<{ node_id: string; xml: string }> = []) {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const row = docs.create({ owner: 'u', title: '汇报', kind: 'deck', content, source: src.length ? 'import' : undefined })
  store.putPackage(row.id, 'pptx', pkg)
  if (src.length) store.putNodeSrc(row.id, src)
  const edit = (o: DeckOp[]) => ops.edit({ doc_id: row.id, base_rev: docs.rev(row.id), mode: 'apply', ops: o }, { actor: 'ai', turnId: null })
  const exportNow = (baseline: number | null = null) => exportPptx({ doc: docs.get(row.id), baseline: baseline ? docs.versionDoc(row.id, baseline) : null, pkg, src: id => store.getNodeSrc(row.id, id), citations: [] })
  const chartShape = () => { let hit: any = null; docs.get(row.id).descendants(n => { if (!hit && n.attrs.kind === 'chart') hit = n; return !hit }); return hit }
  return { store, docs, docId: row.id, edit, exportNow, chartShape }
}

function newDeck() {
  const pkg = pptxTemplate()
  return deckOf(newDeckContent(readLayouts(pkg).layouts, 'SELECT 试验'), pkg)
}

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart>
<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>主要终点</a:t></a:r><a:r><a:t>发生率</a:t></a:r></a:p></c:rich></c:tx></c:title>
<c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>
<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>司美格鲁肽</c:v></c:pt></c:strCache></c:strRef></c:tx>
<c:spPr><a:solidFill><a:srgbClr val="0ea5e9"/></a:solidFill></c:spPr>
<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>MACE</c:v></c:pt><c:pt idx="1"><c:v>心血管死亡</c:v></c:pt></c:strCache></c:strRef></c:cat>
<c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>6.5</c:v></c:pt><c:pt idx="1"><c:v>2.5</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>
<c:ser><c:idx val="1"/><c:order val="1"/><c:tx><c:strRef><c:f>Sheet1!$C$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>安慰剂</c:v></c:pt></c:strCache></c:strRef></c:tx>
<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>MACE</c:v></c:pt><c:pt idx="1"><c:v>心血管死亡</c:v></c:pt></c:strCache></c:strRef></c:cat>
<c:val><c:numRef><c:f>Sheet1!$C$2:$C$3</c:f><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>8</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>
<c:axId val="1"/><c:axId val="2"/></c:barChart></c:plotArea></c:chart></c:chartSpace>`

describe('图表：读取', () => {
  it('从缓存读出类型、标题、类别、系列与数值（缺的点为 null）、系列颜色', () => {
    expect(readChart(SAMPLE)).toEqual({
      type: 'column', title: '主要终点发生率', categories: ['MACE', '心血管死亡'],
      series: [{ name: '司美格鲁肽', values: [6.5, 2.5] }, { name: '安慰剂', values: [8, null] }],
      colors: ['0EA5E9', ''],
    })
    expect(readChart(SAMPLE.replace('<c:barDir val="col"/>', '<c:barDir val="bar"/>'))!.type).toBe('bar')
    expect(readChart('<c:chartSpace><c:chart><c:plotArea/></c:chart></c:chartSpace>')).toBeNull()
  })

  it('数据校验：数值个数要与类别一致、饼图只能一个系列', () => {
    expect(checkChartData({ type: 'column', categories: ['a', 'b'], series: [{ name: 's', values: [1] }] })).toContain('要一样多')
    expect(checkChartData({ type: 'pie', categories: ['a'], series: [{ name: 's', values: [1] }, { name: 't', values: [2] }] })).toContain('只能有一个系列')
    expect(checkChartData({ type: 'line', categories: ['a'], series: [{ name: 's', values: [1] }] })).toBeNull()
  })
})

describe('图表：新建、导入、改数据（人与 AI 同一套操作）', () => {
  it('add_chart → 导出原生图表（部件、关系、内容类型、内嵌工作簿）→ 导入读回同样的数据', () => {
    const t = newDeck()
    const sid = t.docs.get(t.docId).child(0).attrs.id as string
    t.edit([{ op: 'add_chart', slide_id: sid, type: 'column', x: 60, y: 120, w: 600, h: 320, title: '主要终点', categories: ['MACE', '心衰住院'], series: [{ name: '司美格鲁肽', values: [6.5, 3.1] }, { name: '安慰剂', values: [8.0, 3.7] }] }])
    expect(slideRead(t.docs.get(t.docId).child(0), 0, 1)).toContain('系列「司美格鲁肽」：6.5 | 3.1')
    const out = t.exportNow()
    const files = unzipSync(out.bytes)
    const slide = strFromU8(files['ppt/slides/slide1.xml']!)
    const rid = /<c:chart [^>]*r:id="(rId\d+)"/.exec(slide)?.[1]
    expect(rid).toBeTruthy()
    const rels = strFromU8(files['ppt/slides/_rels/slide1.xml.rels']!)
    const target = new RegExp(`Id="${rid}"[^>]*Target="\\.\\./charts/(chart\\d+\\.xml)"`).exec(rels)?.[1]
    expect(target).toBeTruthy()
    const chartXml = strFromU8(files[`ppt/charts/${target}`]!)
    expect(wellFormed(chartXml)).toEqual([])
    expect(wellFormed(slide)).toEqual([])
    expect(strFromU8(files['[Content_Types].xml']!)).toContain(`/ppt/charts/${target}`)
    const book = /Target="\.\.\/embeddings\/([^"]+)"/.exec(strFromU8(files[`ppt/charts/_rels/${target}.rels`]!))![1]!
    const sheet = strFromU8(unzipSync(files[`ppt/embeddings/${book}`]!)['xl/worksheets/sheet1.xml']!)
    expect(sheet).toContain('<t>司美格鲁肽</t>')
    expect(sheet).toContain('<c r="C3"><v>3.7</v></c>')
    // 导出的文件再导入：读回同样的数据，并记下图表部件
    const imported = importPptx(out.bytes)
    let chart: any = null
    imported.doc.descendants(n => { if (!chart && n.attrs.kind === 'chart') chart = n; return !chart })
    expect(chart.attrs.chart_part).toBe(`ppt/charts/${target}`)
    expect(chart.attrs.chart).toMatchObject({ type: 'column', title: '主要终点', categories: ['MACE', '心衰住院'], series: [{ name: '司美格鲁肽', values: [6.5, 3.1] }, { name: '安慰剂', values: [8, 3.7] }] })
  })

  it('导入的图表 chart_set_data（加一个系列、改类别）→ 导出修补图表缓存并重写内嵌工作簿；未改的图表原样', () => {
    const t0 = newDeck()
    const sid = t0.docs.get(t0.docId).child(0).attrs.id as string
    t0.edit([{ op: 'add_chart', slide_id: sid, type: 'column', x: 60, y: 120, w: 600, h: 320, categories: ['MACE', '心衰住院'], series: [{ name: 'A', values: [1, 2] }] }])
    const bytes = t0.exportNow().bytes
    const imported = importPptx(bytes)
    const t = deckOf(imported.doc, bytes, imported.src)
    const id = t.chartShape().attrs.id as string
    // 没改：图表部件原样
    const part = t.chartShape().attrs.chart_part as string
    expect(strFromU8(unzipSync(t.exportNow(1).bytes)[part]!)).toBe(strFromU8(unzipSync(bytes)[part]!))
    t.edit([{ op: 'chart_set_data', shape_id: id, categories: ['MACE', '心衰住院', '全因死亡'], series: [{ name: 'A', values: [6.5, 3.1, 4.2] }, { name: 'B', values: [8, 3.7, 5.1] }], title: '结局' }])
    const files = unzipSync(t.exportNow(1).bytes)
    const xml = strFromU8(files[part]!)
    expect((xml.match(/<c:ser>/g) ?? []).length).toBe(2)
    expect(xml).toContain('<c:v>全因死亡</c:v>')
    expect(xml).toContain('<c:pt idx="2"><c:v>5.1</c:v></c:pt>')
    expect(xml).toContain('<a:t>结局</a:t>')
    expect(wellFormed(xml)).toEqual([])
    expect(readChart(xml)).toMatchObject({ categories: ['MACE', '心衰住院', '全因死亡'], series: [{ name: 'A', values: [6.5, 3.1, 4.2] }, { name: 'B', values: [8, 3.7, 5.1] }] })
    const book = /Target="\.\.\/embeddings\/([^"]+)"/.exec(strFromU8(files[part.replace(/([^/]+)$/, '_rels/$1.rels')]!))![1]!
    expect(strFromU8(unzipSync(files[`ppt/embeddings/${book}`]!)['xl/worksheets/sheet1.xml']!)).toContain('<c r="C4"><v>5.1</v></c>')
  })

  it('无效数据、不是图表的形状给出可操作的错误', () => {
    const t = newDeck()
    const sid = t.docs.get(t.docId).child(0).attrs.id as string
    const expectCode = (fn: () => unknown, code: string) => { try { fn(); throw new Error('应当拒绝') } catch (err) { expect((err as OpError).code).toBe(code) } }
    expectCode(() => t.edit([{ op: 'add_chart', slide_id: sid, type: 'column', x: 0, y: 0, w: 100, h: 100, categories: ['a', 'b'], series: [{ name: 's', values: [1] }] }]), 'invalid_chart')
    const title = (() => { let id = ''; t.docs.get(t.docId).child(0).forEach(s => { if (!id) id = s.attrs.id as string }); return id })()
    expectCode(() => t.edit([{ op: 'chart_set_data', shape_id: title, series: [{ name: 's', values: [1] }] }]), 'invalid_structure')
    expect(DeckOp.safeParse({ op: 'add_chart', slide_id: 's', type: 'pie', x: 0, y: 0, w: 1, h: 1, categories: ['a'], series: [{ name: 's', values: [1] }] }).success).toBe(true)
    expect(DeckOp.safeParse({ op: 'chart_set_data', shape_id: 'x', series: [{ name: 's', values: [1, null] }] }).success).toBe(true)
  })
})
