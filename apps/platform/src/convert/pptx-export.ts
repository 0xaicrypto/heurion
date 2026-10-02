import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { Mark, Node as PMNode } from 'prosemirror-model'
import { DECK_THEMES } from '../model/deck-themes.ts'
import type { CitationRow } from '../store/db.ts'
import { citationOrder } from '../views/read.ts'
import { childrenRaw } from './pptx-import.ts'

/**
 * deck 模型 → pptx（PLATFORM.md §7）：修补式，以原始文件包为底座。
 * - 没改过的幻灯片部件原样保留；改过的页重建形状树：没改过的形状原样写回，改过的形状只替换
 *   文字体 / 位置（沿用原有 bodyPr、lstStyle、段落与文字段格式），新形状按占位符或文本框生成；
 * - 新增的页按版式生成；删页、调整顺序同步 presentation.xml / rels / content types；
 * - 引用写成上标 [n]（编号按全文首次出现顺序）。
 */

export interface PptxExportInput {
  doc: PMNode
  baseline: PMNode | null
  pkg: Uint8Array
  src: (nodeId: string) => string | null
  citations: CitationRow[]
  /** 图片资产（新插入的图片写进 ppt/media）。 */
  asset?: (id: string) => { mime: string; bytes: Uint8Array } | null
}

/** 一页幻灯片的关系表：新图片要在这里登记，返回 rId。 */
interface SlideRels { image(assetId: string): string | null }

const FILL_ELEMENTS = /<a:(solidFill|gradFill|pattFill|blipFill|grpFill)\b[^>]*>[\s\S]*?<\/a:\1>|<a:(noFill|grpFill)\s*\/>/

const fillXml = (fill: string) => fill === 'none' ? '<a:noFill/>' : `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>`

/** spPr 里设置填充：替换已有的顶层填充（不动 a:ln 里的），没有就放在几何之后。 */
function withShapeFill(xml: string, fill: string): string {
  const sp = /<p:spPr\b[^>]*?\/>|<p:spPr\b[^>]*>[\s\S]*?<\/p:spPr>/.exec(xml)
  if (!sp) return xml
  let inner = sp[0].startsWith('<p:spPr') && sp[0].endsWith('/>') ? '' : sp[0].replace(/^<p:spPr\b[^>]*>/, '').replace(/<\/p:spPr>$/, '')
  const openTag = /^<p:spPr\b[^>]*?(?=\/?>)/.exec(sp[0])![0]
  const ln = /<a:ln\b[^>]*?\/>|<a:ln\b[^>]*>[\s\S]*?<\/a:ln>/.exec(inner)?.[0] ?? ''
  const withoutLn = ln ? inner.replace(ln, '\u0000LN\u0000') : inner
  let replaced = withoutLn.replace(FILL_ELEMENTS, fillXml(fill))
  if (replaced === withoutLn) {
    const geom = /<a:(prstGeom|custGeom)\b[^>]*?\/>|<a:(prstGeom|custGeom)\b[^>]*>[\s\S]*?<\/a:\2>/.exec(replaced)
    replaced = geom ? replaced.replace(geom[0], geom[0] + fillXml(fill)) : replaced.replace(/^(<a:xfrm\b[\s\S]*?<\/a:xfrm>)?/, m => m + fillXml(fill))
  }
  inner = replaced.replace('\u0000LN\u0000', ln)
  return xml.replace(sp[0], `${openTag}>${inner}</p:spPr>`)
}

/** 页面背景：替换或新建 p:bg（cSld 的第一个子元素）。 */
function withBackground(xml: string, bg: string): string {
  const el = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
  if (/<p:bg\b[\s\S]*?<\/p:bg>/.test(xml)) return xml.replace(/<p:bg\b[\s\S]*?<\/p:bg>/, el)
  return xml.replace(/<p:cSld\b([^>]*)>/, `<p:cSld$1>${el}`)
}

const PRST = { rect: 'rect', roundRect: 'roundRect', ellipse: 'ellipse' } as const

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g
const esc = (s: string) => s.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 设置 / 删除开始标签上的属性（value = null 删除）。 */
function setAttr(xml: string, tag: string, name: string, value: string | null): string {
  const open = new RegExp(`<${tag}\\b[^>]*?/?>`).exec(xml)
  if (!open) return xml
  let t = open[0]
  const attr = new RegExp(`\\s${name}="[^"]*"`)
  if (attr.test(t)) t = value === null ? t.replace(attr, '') : t.replace(attr, ` ${name}="${value}"`)
  else if (value !== null) t = t.replace(new RegExp(`^<${tag}`), `<${tag} ${name}="${value}"`)
  return xml.slice(0, open.index) + t + xml.slice(open.index + open[0].length)
}

/** 片段里第一个完整的 <name> 元素（自闭合，或带子元素直到匹配的结束标签）。 */
function element(xml: string, name: string): string | null {
  const re = new RegExp(`<${name}\\b[^>]*?/>|<${name}\\b[^>]*>[\\s\\S]*?</${name}>`)
  return re.exec(xml)?.[0] ?? null
}

/** xmldom 序列化出来的片段会自带命名空间声明，放回文件里时去掉（父级已声明）。 */
const stripNs = (xml: string) => xml.replace(/\s+xmlns:(a|r|p)="[^"]*"/g, '')

function runProps(marks: readonly Mark[], forceSup = false): string {
  const rpr = marks.find(m => m.type.name === 'rpr')
  let xml = rpr ? stripNs(rpr.attrs.xml as string) : '<a:rPr lang="zh-CN" dirty="0"/>'
  const has = (n: string) => marks.some(m => m.type.name === n)
  xml = setAttr(xml, 'a:rPr', 'b', has('bold') ? '1' : /\sb="/.test(xml) ? '0' : null)
  xml = setAttr(xml, 'a:rPr', 'i', has('italic') ? '1' : /\si="/.test(xml) ? '0' : null)
  xml = setAttr(xml, 'a:rPr', 'u', has('underline') ? 'sng' : null)
  xml = setAttr(xml, 'a:rPr', 'baseline', has('sup') || forceSup ? '30000' : has('sub') ? '-25000' : null)
  return xml
}

function paragraphXml(p: PMNode, numbers: Map<string, number>): string {
  let ppr = p.attrs.ppr ? stripNs(p.attrs.ppr as string) : ''
  const lvl = p.attrs.lvl as number
  if (ppr) ppr = setAttr(ppr, 'a:pPr', 'lvl', lvl > 0 ? String(lvl) : null)
  else if (lvl > 0) ppr = `<a:pPr lvl="${lvl}"/>`
  let runs = ''
  let lastMarks: readonly Mark[] = []
  p.forEach(c => {
    if (c.isText) {
      lastMarks = c.marks
      runs += `<a:r>${runProps(c.marks)}<a:t>${esc(c.text!)}</a:t></a:r>`
    } else if (c.type.name === 'hard_break') {
      runs += `<a:br>${runProps(lastMarks)}</a:br>`
    } else if (c.type.name === 'citation') {
      const n = numbers.get(c.attrs.cite_id as string)
      runs += `<a:r>${runProps(lastMarks, true)}<a:t>[${n ?? '?'}]</a:t></a:r>`
    }
  })
  return `<a:p>${ppr}${runs}</a:p>`
}

function txBodyInner(shape: PMNode, numbers: Map<string, number>): string {
  let out = ''
  shape.forEach(p => { if (p.type.name === 'paragraph') out += paragraphXml(p, numbers) })
  return out || '<a:p><a:endParaRPr lang="zh-CN"/></a:p>'
}

/** 改过的形状：替换文字体 / 位置，其余原样。 */
function patchShape(src: string, shape: PMNode, before: PMNode | undefined, numbers: Map<string, number>): string {
  let xml = src
  const a = shape.attrs
  const moved = !before || a.x !== before.attrs.x || a.y !== before.attrs.y || a.w !== before.attrs.w || a.h !== before.attrs.h || (before.attrs.xfrm_inherited && !a.xfrm_inherited)
  if (moved && !a.xfrm_inherited) {
    const xfrm = `<a:off x="${a.x}" y="${a.y}"/><a:ext cx="${a.w}" cy="${a.h}"/>`
    if (/<a:off\b[^>]*\/>\s*<a:ext\b[^>]*\/>/.test(xml)) xml = xml.replace(/<a:off\b[^>]*\/>\s*<a:ext\b[^>]*\/>/, xfrm)
    else if (/<p:spPr\s*\/>/.test(xml)) xml = xml.replace(/<p:spPr\s*\/>/, `<p:spPr><a:xfrm>${xfrm}</a:xfrm></p:spPr>`)
    else xml = xml.replace(/<p:spPr(\b[^>]*)>/, `<p:spPr$1><a:xfrm>${xfrm}</a:xfrm>`)
  }
  if (a.fill && a.fill !== (before?.attrs.fill ?? null)) xml = withShapeFill(xml, a.fill as string)
  const textChanged = !before || !before.content.eq(shape.content)
  if (textChanged && (a.kind === 'text' || a.kind === 'shape')) {
    const body = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(xml)
    if (body) {
      const keep = (element(body[1]!, 'a:bodyPr') ?? '<a:bodyPr/>') + (element(body[1]!, 'a:lstStyle') ?? '<a:lstStyle/>')
      xml = xml.replace(body[0], `<p:txBody>${keep}${txBodyInner(shape, numbers)}</p:txBody>`)
    } else {
      xml = xml.replace(/<\/p:sp>\s*$/, `<p:txBody><a:bodyPr/><a:lstStyle/>${txBodyInner(shape, numbers)}</p:txBody></p:sp>`)
    }
  }
  if (textChanged && a.kind === 'table') {
    const cells: PMNode[] = []
    shape.firstChild?.forEach(row => row.forEach(cell => cells.push(cell)))
    let i = 0
    xml = xml.replace(/<a:tc\b([^>]*)>([\s\S]*?)<\/a:tc>/g, (whole, attrs: string, inner: string) => {
      if (/hMerge="1"|vMerge="1"/.test(attrs)) return whole
      const cell = cells[i++]
      if (!cell) return whole
      const bodyPr = element(inner, 'a:bodyPr') ?? '<a:bodyPr/>'
      const rest = inner.replace(/<a:txBody>[\s\S]*?<\/a:txBody>/, '')
      let paras = ''
      cell.forEach(p => { paras += paragraphXml(p, numbers) })
      return `<a:tc${attrs}><a:txBody>${bodyPr}<a:lstStyle/>${paras}</a:txBody>${rest}</a:tc>`
    })
  }
  return xml
}

/**
 * 表格的 a:tbl。tblPr / 列宽 / 行高可沿用原文件（导入的表格增删行列后重建时），否则平分形状的宽高。
 */
function tableXml(shape: PMNode, numbers: Map<string, number>, from?: { tblPr?: string; grid?: string[]; rowHeights?: number[] }): string {
  const a = shape.attrs
  const rows: PMNode[] = []
  shape.firstChild?.forEach(r => rows.push(r))
  const cols = rows[0]?.childCount ?? 1
  const grid = from?.grid && from.grid.length === cols ? from.grid : Array.from({ length: cols }, () => String(Math.round((a.w as number) / cols)))
  const avgH = Math.round((a.h as number) / Math.max(1, rows.length))
  const tr = rows.map((r, ri) => {
    let cells = ''
    r.forEach(cell => {
      let paras = ''
      cell.forEach(p => { paras += paragraphXml(p, numbers) })
      const tcpr = cell.attrs.tcpr ? stripNs(cell.attrs.tcpr as string) : '<a:tcPr/>'
      cells += `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paras || '<a:p/>'}</a:txBody>${tcpr}</a:tc>`
    })
    return `<a:tr h="${from?.rowHeights?.[ri] ?? from?.rowHeights?.at(-1) ?? avgH}">${cells}</a:tr>`
  }).join('')
  return `<a:tbl>${from?.tblPr ?? '<a:tblPr firstRow="1" bandRow="1"/>'}<a:tblGrid>${grid.map(w => `<a:gridCol w="${w}"/>`).join('')}</a:tblGrid>${tr}</a:tbl>`
}

/** 导入的表格增删了行列：保留原 graphicFrame（位置、名字、样式 tblPr、行高、列宽），重建 a:tbl。 */
function rebuildTable(src: string, shape: PMNode, numbers: Map<string, number>): string {
  const tbl = /<a:tbl>[\s\S]*<\/a:tbl>/.exec(src)
  if (!tbl) return src
  const tblPr = element(tbl[0], 'a:tblPr') ?? undefined
  const grid = [...tbl[0].matchAll(/<a:gridCol\b[^>]*\bw="(\d+)"/g)].map(m => m[1]!)
  const rowHeights = [...tbl[0].matchAll(/<a:tr\b[^>]*\bh="(\d+)"/g)].map(m => Number(m[1]))
  return src.replace(tbl[0], tableXml(shape, numbers, { tblPr, grid, rowHeights }))
}

const tableShape = (n: PMNode) => { const t = n.firstChild; return t ? [t.childCount, t.firstChild?.childCount ?? 0].join('×') : '' }

function newShapeXml(shape: PMNode, nvId: number, numbers: Map<string, number>, rels: SlideRels): string {
  const a = shape.attrs
  const name = esc(String(a.name || (a.ph ? 'Placeholder' : 'TextBox')))
  if (a.kind === 'image') {
    const rid = a.asset_id ? rels.image(a.asset_id as string) : null
    if (!rid) return ''
    return `<p:pic><p:nvPicPr><p:cNvPr id="${nvId}" name="${name}" descr="${esc(String(a.description ?? ''))}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${a.x}" y="${a.y}"/><a:ext cx="${a.w}" cy="${a.h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  }
  if (a.kind === 'table') {
    // 新建的表格：p:graphicFrame + a:tbl（列宽平分，行高平分）
    return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${nvId}" name="${name}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${a.x}" y="${a.y}"/><a:ext cx="${a.w}" cy="${a.h}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">${tableXml(shape, numbers)}</a:graphicData></a:graphic></p:graphicFrame>`
  }
  if (!a.ph && (a.geom || (a.fill && a.fill !== 'none'))) {
    // 色块 / 标题条 / 卡片：几何 + 填充，文字居中
    const geom = PRST[(a.geom as keyof typeof PRST) ?? 'rect'] ?? 'rect'
    const xfrm = `<a:xfrm><a:off x="${a.x}" y="${a.y}"/><a:ext cx="${a.w}" cy="${a.h}"/></a:xfrm>`
    return `<p:sp><p:nvSpPr><p:cNvPr id="${nvId}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm}<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>${fillXml((a.fill as string | null) ?? 'none')}<a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0" anchor="ctr"/><a:lstStyle/>${txBodyInner(shape, numbers)}</p:txBody></p:sp>`
  }
  const ph = a.ph ? `<p:ph${a.ph === 'body' ? '' : ` type="${a.ph}"`}${a.ph_idx !== null ? ` idx="${a.ph_idx}"` : ''}/>` : ''
  const xfrm = a.xfrm_inherited ? '' : `<a:xfrm><a:off x="${a.x}" y="${a.y}"/><a:ext cx="${a.w}" cy="${a.h}"/></a:xfrm>`
  const spPr = a.ph
    ? (xfrm || a.fill ? `<p:spPr>${xfrm}${a.fill ? fillXml(a.fill as string) : ''}</p:spPr>` : '<p:spPr/>')
    : `<p:spPr>${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fillXml((a.fill as string | null) ?? 'none')}</p:spPr>`
  const bodyPr = a.ph ? '<a:bodyPr/>' : '<a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr>'
  return `<p:sp><p:nvSpPr><p:cNvPr id="${nvId}" name="${name}"/><p:cNvSpPr${a.ph ? '><a:spLocks noGrp="1"/></p:cNvSpPr>' : ' txBox="1"/>'}<p:nvPr>${ph}</p:nvPr></p:nvSpPr>${spPr}<p:txBody>${bodyPr}<a:lstStyle/>${txBodyInner(shape, numbers)}</p:txBody></p:sp>`
}

export function exportPptx(input: PptxExportInput): { bytes: Uint8Array; warnings: string[] } {
  const warnings: string[] = []
  const files = unzipSync(input.pkg)
  const text = (name: string) => files[name] ? strFromU8(files[name]!) : ''
  const put = (name: string, content: string) => { files[name] = strToU8(content) }
  const order = citationOrder(input.doc)
  const numbers = new Map(order.map((id, i) => [id, i + 1]))
  const baseline = new Map<string, PMNode>()
  input.baseline?.descendants(n => { if (n.attrs.id) baseline.set(n.attrs.id as string, n); return n.type.name !== 'shape' })

  let presXml = text('ppt/presentation.xml')
  let presRels = text('ppt/_rels/presentation.xml.rels')
  let contentTypes = text('[Content_Types].xml')
  // 现有幻灯片：部件 → rId
  const relOf = new Map<string, string>()
  for (const m of presRels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1]
    const target = /Target="([^"]+)"/.exec(m[0])?.[1]
    if (id && target && /slides\/slide\d+\.xml$/.test(target)) relOf.set(`ppt/${target.replace(/^\/?ppt\//, '').replace(/^\.\//, '')}`, id)
  }
  const sldIdOf = new Map<string, string>()
  for (const m of presXml.matchAll(/<p:sldId\b[^>]*?(?:\/>|>\s*<\/p:sldId>)/g)) {
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1]
    for (const [part, r] of relOf) if (r === rid) sldIdOf.set(part, /\bid="(\d+)"/.exec(m[0])![1]!)
  }
  let nextSldId = Math.max(255, ...[...sldIdOf.values()].map(Number)) + 1
  let nextRel = Math.max(0, ...[...presRels.matchAll(/Id="rId(\d+)"/g)].map(m => Number(m[1]))) + 1
  let nextSlideNo = Math.max(0, ...Object.keys(files).map(f => Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(f)?.[1] ?? 0))) + 1

  const keptParts = new Set<string>()
  const sldIds: string[] = []

  // 新插入的图片：写进 ppt/media（同一资产只写一份），在所在页的关系表里登记
  const media = new Map<string, string>()
  const ensureMedia = (assetId: string): string | null => {
    if (media.has(assetId)) return media.get(assetId)!
    const a = input.asset?.(assetId)
    const ext = a ? ({ 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif' } as Record<string, string>)[a.mime] : undefined
    if (!a || !ext) return null
    const name = `heurion-${assetId}.${ext}`
    files[`ppt/media/${name}`] = new Uint8Array(a.bytes)
    if (!new RegExp(`<Default Extension="${ext}"`, 'i').test(contentTypes)) {
      contentTypes = contentTypes.replace('</Types>', `<Default Extension="${ext}" ContentType="${a.mime}"/></Types>`)
    }
    media.set(assetId, name)
    return name
  }
  const slideRels = (part: string, initial: string) => {
    const relsPart = part.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels')
    let xml = initial
    let next = Math.max(0, ...[...xml.matchAll(/Id="rId(\d+)"/g)].map(m => Number(m[1]))) + 1
    const added = new Map<string, string>()
    let dirty = false
    return {
      rels: {
        image(assetId: string): string | null {
          if (added.has(assetId)) return added.get(assetId)!
          const name = ensureMedia(assetId)
          if (!name) { warnings.push(`图片资产 ${assetId} 读取失败，未导出`); return null }
          const rid = `rId${next++}`
          xml = xml.replace('</Relationships>', `<Relationship Id="${rid}" Type="${REL}/image" Target="../media/${name}"/></Relationships>`)
          added.set(assetId, rid)
          dirty = true
          return rid
        },
      } satisfies SlideRels,
      flush(force = false) { if (dirty || force) put(relsPart, xml) },
    }
  }

  input.doc.forEach(slide => {
    const before = baseline.get(slide.attrs.id as string)
    let part = slide.attrs.part as string | null
    if (part && files[part]) {
      keptParts.add(part)
      if (!(before && before.eq(slide))) {
        const r = slideRels(part, text(part.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels')) || EMPTY_RELS)
        let xml = rebuildSlide(text(part), slide, before, input, numbers, r.rels)
        if (slide.attrs.bg && slide.attrs.bg !== (before?.attrs.bg ?? null)) xml = withBackground(xml, slide.attrs.bg as string)
        put(part, xml)
        r.flush()
        patchNotes(part, slide, before)
      }
    } else {
      part = `ppt/slides/slide${nextSlideNo++}.xml`
      keptParts.add(part)
      const layout = (slide.attrs.layout as string | null) ?? Object.keys(files).find(f => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(f))
      const r = slideRels(part, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${layout ? `<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/${layout.split('/').pop()}"/>` : ''}</Relationships>`)
      let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapesXml(slide, [], 2, input, numbers, r.rels)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
      if (slide.attrs.bg) xml = withBackground(xml, slide.attrs.bg as string)
      put(part, xml)
      r.flush(true)
      contentTypes = contentTypes.replace('</Types>', `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`)
      const rid = `rId${nextRel++}`
      presRels = presRels.replace('</Relationships>', `<Relationship Id="${rid}" Type="${REL}/slide" Target="slides/${part.split('/').pop()}"/></Relationships>`)
      relOf.set(part, rid)
      sldIdOf.set(part, String(nextSldId++))
      if (slide.lastChild?.type.name === 'notes') warnings.push('新增幻灯片的备注暂不导出')
    }
    sldIds.push(`<p:sldId id="${sldIdOf.get(part)}" r:id="${relOf.get(part)}"/>`)
  })

  // 删掉的页：移除部件、关系与内容类型
  for (const [part, rid] of relOf) {
    if (keptParts.has(part)) continue
    delete files[part]
    delete files[part.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels')]
    presRels = presRels.replace(new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*?(?:/>|>\\s*</Relationship>)`), '')
    contentTypes = contentTypes.replace(new RegExp(`<Override PartName="/${part.replace(/[.]/g, '\\.')}"[^>]*?(?:/>|>\\s*</Override>)`), '')
  }

  // 页序与页数都没变时不重写列表（原文件的写法可能带扩展属性）
  const originalOrder = [...presXml.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map(m => m[1])
  const unchangedOrder = originalOrder.length === sldIds.length && sldIds.every((x, i) => x.includes(`r:id="${originalOrder[i]}"`))
  if (!unchangedOrder) presXml = /<p:sldIdLst\b[^>]*>[\s\S]*?<\/p:sldIdLst>|<p:sldIdLst\s*\/>/.test(presXml)
    ? presXml.replace(/<p:sldIdLst\b[^>]*>[\s\S]*?<\/p:sldIdLst>|<p:sldIdLst\s*\/>/, `<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>`)
    : presXml.replace(/(<p:sldMasterIdLst\b[\s\S]*?<\/p:sldMasterIdLst>)/, `$1<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>`)
  if (!unchangedOrder) put('ppt/presentation.xml', presXml)
  // 套用过主题：强调色与字体写进 pptx 主题（PowerPoint 里新建的页、图表也匹配）
  const themed = (() => { let k: string | null = null; input.doc.forEach(sl => { k ??= (sl.attrs.theme as string | null) ?? null }); return k })()
  const theme = themed ? DECK_THEMES[themed] : undefined
  if (theme && !(input.baseline && sameThemes(input.baseline, input.doc))) {
    for (const f of Object.keys(files)) {
      if (!/^ppt\/theme\/theme\d+\.xml$/.test(f)) continue
      let xml = text(f)
      for (const [slot, hex] of [['accent1', theme.accent], ['accent2', theme.accent2]] as const) {
        xml = xml.replace(new RegExp(`<a:${slot}>[\\s\\S]*?</a:${slot}>`), `<a:${slot}><a:srgbClr val="${hex}"/></a:${slot}>`)
      }
      xml = xml.replace(/(<a:majorFont>[\s\S]*?)<a:ea typeface="[^"]*"\s*\/>/, `$1<a:ea typeface="${esc(theme.titleFont)}"/>`)
      xml = xml.replace(/(<a:minorFont>[\s\S]*?)<a:ea typeface="[^"]*"\s*\/>/, `$1<a:ea typeface="${esc(theme.bodyFont)}"/>`)
      put(f, xml)
    }
  }
  put('ppt/_rels/presentation.xml.rels', presRels)
  put('[Content_Types].xml', contentTypes)
  return { bytes: zipSync(files), warnings }

  function patchNotes(part: string, slide: PMNode, before: PMNode | undefined): void {
    const now = slide.lastChild?.type.name === 'notes' ? slide.lastChild : null
    const prev = before?.lastChild?.type.name === 'notes' ? before.lastChild : null
    if ((now?.textContent ?? '') === (prev?.textContent ?? '')) return
    const rels = text(part.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'))
    const target = /Type="[^"]*\/notesSlide"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Type="[^"]*\/notesSlide"/.exec(rels)
    const notesPart = target ? `ppt/${(target[1] ?? target[2])!.replace(/^\.\.\//, '')}` : null
    if (!notesPart || !files[notesPart]) { warnings.push('原文件没有备注页的幻灯片，备注改动暂不导出'); return }
    const xml = text(notesPart)
    const body = /(<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<p:ph\b[^>]*type="body"[\s\S]*?<p:txBody>)([\s\S]*?)(<\/p:txBody>)/.exec(xml)
    if (!body) return
    const keep = (element(body[2]!, 'a:bodyPr') ?? '<a:bodyPr/>') + '<a:lstStyle/>'
    let paras = ''
    now?.forEach(p => { paras += paragraphXml(p, numbers) })
    put(notesPart, xml.replace(body[0], `${body[1]}${keep}${paras || '<a:p/>'}${body[3]}`))
  }
}

const EMPTY_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'

/** 每页的主题都没变（不必重写 pptx 主题部件）。 */
function sameThemes(a: PMNode, b: PMNode): boolean {
  if (a.childCount !== b.childCount) return false
  for (let i = 0; i < a.childCount; i++) if (a.child(i).attrs.theme !== b.child(i).attrs.theme) return false
  return true
}

/** 重建一页的形状树：保留组头与其他非形状元素，形状按模型顺序。 */
function rebuildSlide(xml: string, slide: PMNode, before: PMNode | undefined, input: PptxExportInput, numbers: Map<string, number>, rels: SlideRels): string {
  const raw = childrenRaw(xml, /<p:spTree\b[^>]*>/)
  const head = raw.filter(r => /^<p:(nvGrpSpPr|grpSpPr)\b/.test(r))
  const usedIds = [...xml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g)].map(m => Number(m[1]))
  const body = shapesXml(slide, head, Math.max(1, ...usedIds) + 1, input, numbers, rels, before)
  const open = /<p:spTree\b[^>]*>/.exec(xml)!
  const close = xml.indexOf('</p:spTree>', open.index)
  return xml.slice(0, open.index + open[0].length) + body + xml.slice(close)
}

function shapesXml(slide: PMNode, head: string[], nextId: number, input: PptxExportInput, numbers: Map<string, number>, rels: SlideRels, before?: PMNode): string {
  const prev = new Map<string, PMNode>()
  before?.forEach(s => { if (s.attrs.id) prev.set(s.attrs.id as string, s) })
  let out = head.join('')
  let id = nextId
  slide.forEach(shape => {
    if (shape.type.name !== 'shape') return
    const src = input.src(shape.attrs.id as string)
    const old = prev.get(shape.attrs.id as string)
    if (src && old && old.eq(shape)) out += src
    else if (src && old && shape.attrs.kind === 'table' && tableShape(old) !== tableShape(shape)) out += rebuildTable(patchShape(src, shape, old, numbers), shape, numbers)
    else if (src) out += patchShape(src, shape, old, numbers)
    else out += newShapeXml(shape, id++, numbers, rels)
  })
  return out
}
