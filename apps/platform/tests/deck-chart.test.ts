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
import { chartSvg } from '../web/src/deck.ts'

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

describe('图表：缩减数据、各类型、人工编辑', () => {
  it('导入的图表删系列、删类别、去掉标题 → 缓存与工作簿同步缩减，单独设色的点裁掉', () => {
    const t0 = newDeck()
    const sid = t0.docs.get(t0.docId).child(0).attrs.id as string
    t0.edit([{ op: 'add_chart', slide_id: sid, type: 'column', x: 60, y: 120, w: 600, h: 320, title: '结局', categories: ['a', 'b', 'c'], series: [{ name: 'A', values: [1, 2, 3] }, { name: 'B', values: [4, 5, 6] }] }])
    const bytes = t0.exportNow().bytes
    const imported = importPptx(bytes)
    const t = deckOf(imported.doc, bytes, imported.src)
    const id = t.chartShape().attrs.id as string
    const part = t.chartShape().attrs.chart_part as string
    t.edit([{ op: 'chart_set_data', shape_id: id, categories: ['a', 'b'], series: [{ name: 'A', values: [7, null] }], title: '' }])
    const files = unzipSync(t.exportNow(1).bytes)
    const xml = strFromU8(files[part]!)
    expect(wellFormed(xml)).toEqual([])
    expect(xml).not.toContain('<c:title>')
    expect(xml).toContain('<c:autoTitleDeleted val="1"/>')
    expect(readChart(xml)).toMatchObject({ categories: ['a', 'b'], series: [{ name: 'A', values: [7, null] }] })
    const book = /Target="\.\.\/embeddings\/([^"]+)"/.exec(strFromU8(files[part.replace(/([^/]+)$/, '_rels/$1.rels')]!))![1]!
    const sheet = strFromU8(unzipSync(files[`ppt/embeddings/${book}`]!)['xl/worksheets/sheet1.xml']!)
    expect(sheet).toContain('<c r="B2"><v>7</v></c>')
    expect(sheet).not.toContain('C1')
    expect(sheet).not.toContain('r="4"')
  })

  it('折线 / 条形 / 面积 / 饼 / 圆环：导出的部件合法，导入读回同样的类型与数据', () => {
    for (const type of ['line', 'bar', 'area', 'pie', 'doughnut'] as const) {
      const t = newDeck()
      const sid = t.docs.get(t.docId).child(0).attrs.id as string
      t.edit([{ op: 'add_chart', slide_id: sid, type, x: 60, y: 120, w: 600, h: 320, title: 'T & <x>', categories: ['甲', '乙', '丙'], series: [{ name: 'S', values: [3, null, 1.25] }] }])
      const out = t.exportNow()
      const files = unzipSync(out.bytes)
      const part = Object.keys(files).find(f => /^ppt\/charts\/chart\d+\.xml$/.test(f))!
      expect(wellFormed(strFromU8(files[part]!))).toEqual([])
      let chart: any = null
      importPptx(out.bytes).doc.descendants(n => { if (!chart && n.attrs.kind === 'chart') chart = n; return !chart })
      expect(chart.attrs.chart).toMatchObject({ type, title: 'T & <x>', categories: ['甲', '乙', '丙'], series: [{ name: 'S', values: [3, null, 1.25] }] })
    }
  })

  it('画布（actor=user）与 AI 走同一个 chart_set_data：提交记为用户，slide_read 读到新数据', () => {
    const t = newDeck()
    const sid = t.docs.get(t.docId).child(0).attrs.id as string
    t.edit([{ op: 'add_chart', slide_id: sid, type: 'column', x: 60, y: 120, w: 600, h: 320, categories: ['a'], series: [{ name: 'A', values: [1] }] }])
    const id = t.chartShape().attrs.id as string
    const ops = new OpService(t.docs)
    const commits: string[] = []
    t.docs.on('commit', e => commits.push(e.actor))
    ops.edit({ doc_id: t.docId, base_rev: t.docs.rev(t.docId), mode: 'apply', ops: [{ op: 'chart_set_data', shape_id: id, categories: ['a', 'b'], series: [{ name: 'A', values: [1, 2] }], title: '人改的' }] }, { actor: 'user', turnId: null })
    expect(commits).toEqual(['user'])
    expect(t.chartShape().attrs.chart).toMatchObject({ title: '人改的', categories: ['a', 'b'], series: [{ name: 'A', values: [1, 2] }] })
    expect(slideRead(t.docs.get(t.docId).child(0), 0, 1)).toContain('柱状图「人改的」')
  })
})

describe('图表：画布预览（SVG）', () => {
  const data = { type: 'column', title: 'A<b>', categories: ['x', 'y', 'z'], series: [{ name: 's1', values: [1, null, 3] }, { name: 's2', values: [-2, 2, 0] }] }
  it('柱状：每个非空数值一根柱子，负值向下；标题转义', () => {
    const svg = chartSvg(data, 400, 240)
    expect(wellFormed(svg)).toEqual([])
    // 5 根柱子 + 2 个图例方块
    expect((svg.match(/<rect /g) ?? []).length).toBe(7)
    expect(svg).toContain('A&lt;b&gt;')
  })
  it('折线 / 饼 / 圆环：路径与扇区数正确', () => {
    expect((chartSvg({ ...data, type: 'line' }, 400, 240).match(/<path /g) ?? []).length).toBe(2)
    const pie = chartSvg({ type: 'pie', categories: ['a', 'b', 'c'], series: [{ name: 's', values: [1, 2, 3] }] }, 300, 300)
    expect((pie.match(/<path /g) ?? []).length).toBe(3)
    expect(chartSvg({ type: 'doughnut', categories: ['a'], series: [{ name: 's', values: [5] }] }, 300, 300)).toMatch(/<circle [^>]*\/><circle /)
  })
})
