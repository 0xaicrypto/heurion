import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { Mark, Node as PMNode } from 'prosemirror-model'
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
}

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
  const textChanged = !before || !before.content.eq(shape.content)
  if (textChanged && a.kind === 'text') {
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

function newShapeXml(shape: PMNode, nvId: number, numbers: Map<string, number>): string {
  const a = shape.attrs
  const name = esc(String(a.name || (a.ph ? 'Placeholder' : 'TextBox')))
  const ph = a.ph ? `<p:ph${a.ph === 'body' ? '' : ` type="${a.ph}"`}${a.ph_idx !== null ? ` idx="${a.ph_idx}"` : ''}/>` : ''
  const xfrm = a.xfrm_inherited ? '' : `<a:xfrm><a:off x="${a.x}" y="${a.y}"/><a:ext cx="${a.w}" cy="${a.h}"/></a:xfrm>`
  const spPr = a.ph ? (xfrm ? `<p:spPr>${xfrm}</p:spPr>` : '<p:spPr/>') : `<p:spPr>${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>`
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

  input.doc.forEach(slide => {
    const before = baseline.get(slide.attrs.id as string)
    let part = slide.attrs.part as string | null
    if (part && files[part]) {
      keptParts.add(part)
      if (!(before && before.eq(slide))) {
        put(part, rebuildSlide(text(part), slide, before, input, numbers))
        patchNotes(part, slide, before)
      }
    } else {
      part = `ppt/slides/slide${nextSlideNo++}.xml`
      keptParts.add(part)
      put(part, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapesXml(slide, [], 2, input, numbers)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`)
      const layout = (slide.attrs.layout as string | null) ?? Object.keys(files).find(f => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(f))
      put(part.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${layout ? `<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/${layout.split('/').pop()}"/>` : ''}</Relationships>`)
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

/** 重建一页的形状树：保留组头与其他非形状元素，形状按模型顺序。 */
function rebuildSlide(xml: string, slide: PMNode, before: PMNode | undefined, input: PptxExportInput, numbers: Map<string, number>): string {
  const raw = childrenRaw(xml, /<p:spTree\b[^>]*>/)
  const head = raw.filter(r => /^<p:(nvGrpSpPr|grpSpPr)\b/.test(r))
  const usedIds = [...xml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g)].map(m => Number(m[1]))
  const body = shapesXml(slide, head, Math.max(1, ...usedIds) + 1, input, numbers, before)
  const open = /<p:spTree\b[^>]*>/.exec(xml)!
  const close = xml.indexOf('</p:spTree>', open.index)
  return xml.slice(0, open.index + open[0].length) + body + xml.slice(close)
}

function shapesXml(slide: PMNode, head: string[], nextId: number, input: PptxExportInput, numbers: Map<string, number>, before?: PMNode): string {
  const prev = new Map<string, PMNode>()
  before?.forEach(s => { if (s.attrs.id) prev.set(s.attrs.id as string, s) })
  let out = head.join('')
  let id = nextId
  slide.forEach(shape => {
    if (shape.type.name !== 'shape') return
    const src = input.src(shape.attrs.id as string)
    const old = prev.get(shape.attrs.id as string)
    if (src && old && old.eq(shape)) out += src
    else if (src) out += patchShape(src, shape, old, numbers)
    else out += newShapeXml(shape, id++, numbers)
  })
  return out
}
