import zlib from 'zlib'

/**
 * #1046/#1047/#1048/#1052 — PPTX 导入保真度批次的固定最小 fixture 构建器。
 * #1059/#1062 — 后续跟进批次的反同构扩展（构造与解析器假设不同的形状）：
 *   - catPts/valPts：图表 <c:pt> 自定义 idx（稀疏/乱序）— 锁定 idx 对齐修复
 *   - notesPart/omitNotesRel：notes part 文件名与页序错位 + rels 无序 —
 *     锁定「notes 按 slide rels 定位」修复（页序假设下测试恒真）
 *   - smartArts：同页多 SmartArt 且 rels 逆序写入 + drawing 附 dataModelExt
 *     relId — 锁定「frame r:id 配对」修复（rels 出现序假设下测试恒真）
 *
 * pptx = zip + OOXML。zip 用 stored 条目手写（与 tests/unit/pptx-extractor.test.ts
 * 的零依赖 buildZip 同一实现，抽为共享 helper 供测试复用）；XML 部分用真实
 * OOXML 命名空间前缀（a:/p:/c:/dgm:/dsp:）与真实 part 布局：
 *   - ppt/slides/slideN.xml（标题/正文占位符 + graphicFrame）
 *   - ppt/slides/_rels/slideN.xml.rels（chart / diagramDrawing / notesSlide 关系）
 *   - ppt/notesSlides/notesSlideN.xml（speaker notes）
 *   - ppt/charts/chartN.xml（barChart/lineChart/pieChart/radarChart + c:ser/c:cat/c:val）
 *   - ppt/diagrams/dataN.xml（SmartArt 节点数据，仅装饰）与 drawingN.xml
 *     （PowerPoint 为兼容旧渲染器保存的降级绘图 dsp:drawing — #1052 解析目标）
 *   - ppt/media/*（内嵌图片）
 */

function crc32(buf: Buffer): number {
  return zlib.crc32(buf)
}

/** 构造一个 zip（stored 条目）— 与标准 ZIP 中央目录布局一致。 */
function buildZip(entries: Array<{ name: string; data: Buffer | string }>): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const { name, data } of entries) {
    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8')
    const nameBuf = Buffer.from(name, 'utf-8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // method = stored
    local.writeUInt32LE(crc32(dataBuf), 14)
    local.writeUInt32LE(dataBuf.length, 18)
    local.writeUInt32LE(dataBuf.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, dataBuf)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(0, 8)
    cen.writeUInt16LE(0, 10)
    cen.writeUInt32LE(crc32(dataBuf), 16)
    cen.writeUInt32LE(dataBuf.length, 20)
    cen.writeUInt32LE(dataBuf.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)
    offset += local.length + nameBuf.length + dataBuf.length
  }
  const cdStart = offset
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(cdStart, 16)
  return Buffer.concat([...chunks, cd, eocd])
}

/* ── OOXML 命名空间（真实 URI）────────────────────────────────── */

const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  dgm: 'http://schemas.openxmlformats.org/drawingml/2006/diagram',
  dsp: 'http://schemas.microsoft.com/office/drawing/2008/diagram',
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

function run(text: string): string {
  return `<a:r><a:rPr lang="zh-CN"/><a:t>${text}</a:t></a:r>`
}

function para(text: string): string {
  return `<a:p>${run(text)}</a:p>`
}

function txBody(paras: string[]): string {
  return `<a:txBody><a:bodyPr/><a:lstStyle/>${paras.map(para).join('')}</a:txBody>`
}

/** 标题占位符 shape。 */
function titleShape(text: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/>${txBody(text ? [text] : [])}</p:sp>`
}

/** 正文占位符 shape。 */
function bodyShape(paras: string[]): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:spPr/>${txBody(paras)}</p:sp>`
}

/** 表格 graphicFrame（<a:tbl>）。单元格支持 gridSpan/rowSpan/hMerge/vMerge 属性（#1047 合并降级）。 */
export interface FixtureTableCell { text: string; gridSpan?: number; rowSpan?: number; hMerge?: boolean; vMerge?: boolean }
export interface FixtureTable { rows: FixtureTableCell[][] }

function tableFrame(table: FixtureTable): string {
  const cellXml = (c: FixtureTableCell): string => {
    const attrs = [
      c.gridSpan ? `gridSpan="${c.gridSpan}"` : '',
      c.rowSpan ? `rowSpan="${c.rowSpan}"` : '',
      c.hMerge ? 'hMerge="1"' : '',
      c.vMerge ? 'vMerge="1"' : '',
    ].filter(Boolean).join(' ')
    return `<a:tc${attrs ? ` ${attrs}` : ''}>${txBody(c.text ? [c.text] : [])}<a:tcPr/></a:tc>`
  }
  const tbl = `<a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${'<a:gridCol w="3000000"/>'.repeat(3)}</a:tblGrid>${table.rows
    .map((row) => `<a:tr h="500000">${row.map(cellXml).join('')}</a:tr>`)
    .join('')}</a:tbl>`
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="838200" y="1143000"/><a:ext cx="6096000" cy="2133600"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">${tbl}</a:graphicData></a:graphic></p:graphicFrame>`
}

/** 图表 fixture（#1048）。kind 为 OOXML 原生类型名；withPart=false 模拟关系断链。 */
export interface FixtureChart {
  kind: string
  categories: string[]
  series: Array<{ name: string; values: number[] }>
  title?: string
  withPart?: boolean
  /**
   * #1059: 覆盖首系列 cat 的 `<c:pt>` 原始 XML（自定义 idx 属性/稀疏/乱序）—
   * 构造与解析器「按下标位置配对」假设不同的形状，锁定 idx 对齐修复。
   */
  catPts?: string[]
  /** #1059: 同上，覆盖首系列 val 的 `<c:pt>` 原始 XML。 */
  valPts?: string[]
}

function chartFrame(rid: string): string {
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Chart"/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="838200" y="1143000"/><a:ext cx="6096000" cy="3657600"/></p:xfrm><a:graphic><a:graphicData uri="${NS.c}"><c:chart xmlns:c="${NS.c}" xmlns:r="${NS.r}" r:id="${rid}"/></a:graphicData></a:graphic></p:graphicFrame>`
}

function chartPartXml(chart: FixtureChart): string {
  const plotTag = chart.kind
  const serXml = chart.series
    .map((ser, si) => {
      // #1059: catPts/valPts 覆盖首系列（si===0）的 <c:pt> 原始 XML — 自定义
      // idx（稀疏/乱序）供 idx 对齐回归；未覆盖时按连续 idx 生成（真实 Excel 产物）。
      const catPtXml = chart.catPts && si === 0
        ? chart.catPts.join('')
        : chart.categories.map((cat, i) => `<c:pt idx="${i}"><c:v>${cat}</c:v></c:pt>`).join('')
      const valPtXml = chart.valPts && si === 0
        ? chart.valPts.join('')
        : ser.values.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')
      return `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${ser.name}</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$9</c:f><c:strCache><c:ptCount val="${chart.categories.length}"/>${catPtXml
        }</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$9</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${ser.values.length}"/>${valPtXml
        }</c:numCache></c:numRef></c:val></c:ser>`
    })
    .join('')
  const axes = chart.kind === 'pieChart' || chart.kind === 'radarChart' ? '' : '<c:catAx><c:axId val="1"/></c:catAx><c:valAx><c:axId val="2"/></c:valAx>'
  return `${XML_DECL}<c:chartSpace xmlns:c="${NS.c}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${chart.title || ''}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:${plotTag}>${serXml}</c:${plotTag}>${axes}</c:plotArea></c:chart></c:chartSpace>`
}

/** SmartArt fixture（#1052）。shapes 为降级绘图（dsp:drawing）里的形状文字。 */
export interface FixtureSmartArt {
  /** 降级绘图形状文字（按创建顺序，解析侧按几何位置排序）。 */
  shapes: string[]
  /** true → 不写 drawing part（降级绘图缺失场景）。 */
  missingDrawing?: boolean
  /** 覆盖默认横向排布坐标（EMU）— 验证解析侧按几何位置排序。 */
  positions?: Array<{ x: number; y: number }>
}

function smartArtFrame(dmRid: string, loRid: string, qsRid: string, csRid: string): string {
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="SmartArt"/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="838200" y="1143000"/><a:ext cx="6096000" cy="2743200"/></p:xfrm><a:graphic><a:graphicData uri="${NS.dgm}"><dgm:relIds xmlns:dgm="${NS.dgm}" xmlns:r="${NS.r}" r:dm="${dmRid}" r:lo="${loRid}" r:qs="${qsRid}" r:cs="${csRid}"/></a:graphicData></a:graphic></p:graphicFrame>`
}

function diagramDataStub(index: number): string {
  return `${XML_DECL}<dgm:dataModel xmlns:dgm="${NS.dgm}" xmlns:a="${NS.a}"><dgm:ptLst><dgm:pt modelId="0" type="doc"><dgm:prSet loTypeId="process"/></dgm:pt></dgm:ptLst></dgm:dataModel>`
}

/** 降级绘图 part：dsp:sp 形状按 xfrm 给出几何位置（off/emu），txBody 载文字。
 * #1062-4: 附 dsp:dataModelExt relId（PowerPoint 把 drawing 关联回该 SmartArt
 * frame 的 diagramData r:id）— 同页多 SmartArt 的权威配对依据。 */
function diagramDrawingXml(shapes: string[], positions?: Array<{ x: number; y: number }>, dmRid?: string): string {
  // 默认三段横向流程排布（y 相同、x 递增）— 排序应保持给出顺序；个别形状给
  // 不同 y 以覆盖几何排序。
  const W = 1828800
  const spXml = shapes
    .map((text, i) => {
      const pos = positions?.[i] ?? { x: 838200 + (i % 3) * (W + 365760), y: 1143000 + Math.floor(i / 3) * 1219200 }
      return `<dsp:sp><dsp:nvSpPr/><dsp:spPr><a:xfrm><a:off x="${pos.x}" y="${pos.y}"/><a:ext cx="${W}" cy="914400"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom></dsp:spPr><dsp:style/><dsp:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN"/><a:t>${text}</a:t></a:r></a:p></dsp:txBody></dsp:sp>`
    })
    .join('')
  const dataModelExt = dmRid ? `<dsp:dataModelExt relId="${dmRid}" minVer="${NS.dgm}"/>` : ''
  return `${XML_DECL}<dsp:drawing xmlns:dsp="${NS.dsp}" xmlns:a="${NS.a}">${dataModelExt}<dsp:spTree><dsp:nvGrpSpPr/><dsp:grpSpPr/>${spXml}</dsp:spTree></dsp:drawing>`
}

function notesSlideXml(notes: string): string {
  return `${XML_DECL}<p:notes xmlns:p="${NS.p}" xmlns:a="${NS.a}"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:spPr/>${txBody([notes])}</p:sp></p:spTree></p:cSld></p:notes>`
}

export interface FixtureSlide {
  title?: string
  paragraphs?: string[]
  notes?: string
  /**
   * #1062-2: notes part 文件名覆盖（默认 notesSlide{n}.xml）。设为非默认值时
   * notesSlide 编号与页序错位（如第 1 页 → notesSlide2.xml），且该关系写在
   * slide rels 最前（反同构：rels 为无序映射）— 锁定「按 rels 定位」修复。
   */
  notesPart?: string
  /** #1062-2: 不写 notesSlide 关系（旧生成器产物）→ 解析侧按页序兜底。 */
  omitNotesRel?: boolean
  table?: FixtureTable
  charts?: FixtureChart[]
  /** SmartArt（每 slide 一个；数组内为多个时按序排列）。 */
  smartArt?: FixtureSmartArt
  /** #1062-4: 同页多个 SmartArt（与 smartArt 合并；rels 按逆序写入 — 反同构）。 */
  smartArts?: FixtureSmartArt[]
  media?: Array<{ name: string; data: Buffer }>
}

export interface BuiltPptx {
  buffer: Buffer
  /** 生成的 slide XML（调试/断言用）。 */
  slideXml: string[]
}

/** 组装最小真实结构 pptx（zip 字节流）。 */
export function buildPptxFixture(slides: FixtureSlide[]): BuiltPptx {
  const entries: Array<{ name: string; data: Buffer | string }> = [
    { name: '[Content_Types].xml', data: `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    { name: 'ppt/presentation.xml', data: `${XML_DECL}<p:presentation xmlns:p="${NS.p}" xmlns:r="${NS.r}"><p:sldIdLst>${slides
      .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
      .join('')}</p:sldIdLst></p:presentation>` },
    { name: 'ppt/_rels/presentation.xml.rels', data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`)
      .join('')}</Relationships>` },
  ]

  let chartIdx = 0
  let diagramIdx = 0
  slides.forEach((slide, i) => {
    const n = i + 1
    const rels: string[] = []
    let rid = 0
    const frames: string[] = []
    const smartArts = [...(slide.smartArt ? [slide.smartArt] : []), ...(slide.smartArts || [])]

    if (slide.table) frames.push(tableFrame(slide.table))

    for (const chart of slide.charts || []) {
      rid += 1
      const chartPart = `chart${++chartIdx}`
      if (chart.withPart !== false) {
        entries.push({ name: `ppt/charts/${chartPart}.xml`, data: chartPartXml(chart) })
      }
      rels.push(`<Relationship Id="rId${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/${chartPart}.xml"/>`)
      frames.push(chartFrame(`rId${rid}`))
    }

    const smartArtRels: string[] = []
    const smartArtFrames: string[] = []
    for (const sa of smartArts) {
      rid += 1
      const dmRid = `rId${rid}`
      const drawingPart = `drawing${++diagramIdx}`
      entries.push({ name: `ppt/diagrams/data${diagramIdx}.xml`, data: diagramDataStub(diagramIdx) })
      if (!sa.missingDrawing) {
        entries.push({ name: `ppt/diagrams/${drawingPart}.xml`, data: diagramDrawingXml(sa.shapes, sa.positions, dmRid) })
      }
      smartArtRels.push(`<Relationship Id="${dmRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData" Target="../diagrams/data${diagramIdx}.xml"/>`)
      if (!sa.missingDrawing) {
        rid += 1
        smartArtRels.push(`<Relationship Id="rId${rid}" Type="http://schemas.microsoft.com/office/2007/relationships/diagramDrawing" Target="../diagrams/${drawingPart}.xml"/>`)
      }
      smartArtFrames.push(smartArtFrame(dmRid, `rId${rid}`, `rId${rid}`, `rId${rid}`))
    }
    // #1062-4 反同构：同页多 SmartArt 时 rels 按逆序写入（rels 是无序映射，
    // 真实文件不保证出现序）— 锁定「按 frame 引用的 r:id 配对」修复。
    if (smartArts.length > 1) {
      rels.push(...smartArtRels.slice().reverse())
    } else {
      rels.push(...smartArtRels)
    }
    frames.push(...smartArtFrames)

    for (const m of slide.media || []) {
      entries.push({ name: `ppt/media/${m.name}`, data: m.data })
    }

    const shapeXml = `${titleShape(slide.title || '')}${slide.paragraphs?.length ? bodyShape(slide.paragraphs) : ''}`
    const slideXml = `${XML_DECL}<p:sld xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${shapeXml}${frames.join('')}</p:spTree></p:cSld></p:sld>`
    entries.push({ name: `ppt/slides/slide${n}.xml`, data: slideXml })
    // #1062-2: notes part（默认 notesSlide{n}.xml，notesPart 可覆盖为页序错位名）
    // + slide rels 的 notesSlide 关系（此前 fixture 从不写该关系，解析侧只能按页序猜）。
    if (slide.notes) {
      const notesPartName = slide.notesPart || `notesSlide${n}.xml`
      entries.push({ name: `ppt/notesSlides/${notesPartName}`, data: notesSlideXml(slide.notes) })
      if (!slide.omitNotesRel) {
        const notesRel = `<Relationship Id="notesRelId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/${notesPartName}"/>`
        // 反同构：自定义 notesPart（页序错位）时关系写在 rels 最前（rels 无序）。
        if (slide.notesPart) rels.unshift(notesRel)
        else rels.push(notesRel)
      }
    }
    if (rels.length > 0 || slide.media?.length) {
      const mediaRels = (slide.media || []).map((m, k) => `<Relationship Id="mediaRid${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${m.name}"/>`)
      entries.push({ name: `ppt/slides/_rels/slide${n}.xml.rels`, data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}${mediaRels.join('')}</Relationships>` })
    }
  })

  return { buffer: buildZip(entries), slideXml: [] }
}
