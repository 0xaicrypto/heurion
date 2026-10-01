import { randomBytes } from 'node:crypto'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

/**
 * S1 id 底座（docs/DESIGN.md §4.1）—— 文件内嵌持久 id + 投影 v1。
 *
 * 管理面的寻址、合并、锚点审计都建立在「id 存在文件里、跨编辑稳定」之上：
 * - docx：段落 id 用 OOXML 原生 `w14:paraId`。导入时把缺失的补上、重复的重分配，
 *   其余字节不动（字符串手术，不重新序列化 XML —— 保真的关键）。
 * - pptx：形状 id 原生（`p:cNvPr@id`），寻址用复合 id `<slidePart>#<id>`。
 * - 投影：每版本导入生成的派生视图（不是真相），服务锚点审计 / diff / 前端。
 */

export type ProjectionNodeKind = 'heading' | 'paragraph' | 'list' | 'table' | 'opaque'

export interface ProjectionNode {
  id: string
  kind: ProjectionNodeKind
  level?: number
  text: string
  geometry?: { x: number; y: number; w: number; h: number; rot?: number }
  locked?: boolean
}

export interface ProjectionSlide {
  /** 页 id = slide part 路径（如 ppt/slides/slide2.xml）。 */
  id: string
  index: number
  shapes: ProjectionNode[]
}

export interface Projection {
  nodes?: ProjectionNode[]
  slides?: ProjectionSlide[]
}

/** id 分配统计（写进日志，便于评测 id 存活率）。 */
export interface IdStats { assigned: number; reassigned: number }

/** id 存活率告警阈值：低于它视为整文重写（DESIGN.md §4.3）。 */
export const ID_SURVIVAL_WARN = 0.8

const W14_NS = 'http://schemas.microsoft.com/office/word/2010/wordml'
export const DOC_XML = 'word/document.xml'

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** ST_LongHexNumber：8 位十六进制、非零。生成值与已有 id 大小写不敏感地去重。 */
function genParaId(taken: Set<string>): string {
  for (;;) {
    const id = [...randomBytes(4)].map(b => (b & 0x7f).toString(16).padStart(2, '0')).join('').toUpperCase()
    if (id !== '00000000' && !taken.has(id.toLowerCase())) { taken.add(id.toLowerCase()); return id }
  }
}

function tagEnd(xml: string, from: number): number {
  return xml.indexOf('>', from)
}

/**
 * docx 段落 id 手术：补缺失 paraId、重分配重复项（大小写不敏感判重，首现保留）。
 * 只在 `<w:p ...>` 开标签上做插入/替换，文档其余内容逐字节保留。
 * （属性值里不会出现裸 `>`，OOXML 序列化器一律转义，按此假设扫描。）
 */
export function ensureDocxParaIds(bytes: Uint8Array): { bytes: Uint8Array; stats: IdStats } {
  const stats: IdStats = { assigned: 0, reassigned: 0 }
  let all: Record<string, Uint8Array>
  try {
    all = unzipSync(bytes)
  } catch {
    return { bytes, stats } // 非法 zip：不阻塞落版，投影层兜底
  }
  const entry = all[DOC_XML]
  if (!entry) return { bytes, stats }
  const xml = strFromU8(entry)

  // 1) 根元素声明 w14 命名空间（python-docx 等生成的文件可能没有）。
  let patched = xml
  const rootStart = xml.indexOf('<w:document')
  if (rootStart >= 0) {
    const rootEnd = tagEnd(xml, rootStart) // '>' 的下标（不含）
    if (rootEnd >= 0) {
      const tag = xml.slice(rootStart, rootEnd + 1)
      let fixed = tag
      if (!fixed.includes('xmlns:w14=')) fixed = fixed.replace(/>$/, ` xmlns:w14="${W14_NS}">`)
      const ignorable = /mc:Ignorable="([^"]*)"/.exec(fixed)
      if (ignorable) {
        if (!ignorable[1]!.split(/\s+/).includes('w14')) {
          fixed = fixed.replace(ignorable[0], `mc:Ignorable="${ignorable[1]} w14"`)
        }
      } else if (fixed.includes('xmlns:mc=')) {
        fixed = fixed.replace(/>$/, ' mc:Ignorable="w14">')
      }
      if (fixed !== tag) patched = xml.slice(0, rootStart) + fixed + xml.slice(rootEnd + 1)
    }
  }

  // 2) 扫描全部 `<w:p` 开标签，登记已有 id。
  interface PTag { start: number; end: number; id: string | null; selfClosing: boolean }
  const tags: PTag[] = []
  for (let i = 0; i < patched.length;) {
    const at = patched.indexOf('<w:p', i)
    if (at < 0) break
    const next = patched[at + 4]
    if (next !== ' ' && next !== '>' && next !== '/') { i = at + 4; continue }
    const end = tagEnd(patched, at)
    if (end < 0) break
    const tag = patched.slice(at, end + 1)
    const id = /w14:paraId="([0-9A-Fa-f]+)"/.exec(tag)?.[1] ?? null
    tags.push({ start: at, end: end + 1, id, selfClosing: tag.endsWith('/>') })
    i = end + 1
  }

  // 3) 分配：缺失的拿新 id；重复项首现保留、其余拿新 id。
  const taken = new Set<string>()
  for (const t of tags) if (t.id) taken.add(t.id.toLowerCase())
  const finals = new Map<number, string>()
  const firstSeen = new Map<string, number>()
  for (let k = 0; k < tags.length; k++) {
    const t = tags[k]!!
    if (!t.id) { finals.set(k, genParaId(taken)); stats.assigned++; continue }
    if (!firstSeen.has(t.id.toLowerCase())) { firstSeen.set(t.id.toLowerCase(), k); finals.set(k, t.id); continue }
    finals.set(k, genParaId(taken))
    stats.reassigned++
  }

  // 4) 从后往前替换，避免偏移失效。其余 part 原样保留（zip 容器会重建，内容不变）。
  let out = patched
  for (let k = tags.length - 1; k >= 0; k--) {
    const t = tags[k]!
    const final = finals.get(k)!
    if (t.id === final) continue
    const tag = out.slice(t.start, t.end)
    const replaced = t.id
      ? tag.replace(/w14:paraId="([0-9A-Fa-f]+)"/, `w14:paraId="${final}"`)
      : t.selfClosing
        ? tag.replace(/\s*\/>$/, ` w14:paraId="${final}"/>`)
        : tag.replace(/>$/, ` w14:paraId="${final}">`)
    out = out.slice(0, t.start) + replaced + out.slice(t.end)
  }

  if (out === xml) return { bytes, stats }
  return { bytes: zipSync({ ...all, [DOC_XML]: strToU8(out) }), stats }
}

/** file-backed id 判定：w14:paraId 格式（8 位 hex）。 */
export const isFileBackedId = (id: string): boolean => /^[0-9A-Fa-f]{8}$/.test(id)

const normText = (s: string): string => s.replace(/\s+/g, '').toLowerCase()

/**
 * docx 段落 id 对齐重建（S4 关键路径）：LibreOffice / Collabora 回写 docx 时会**重新生成**
 * 全部 paraId（不回写导入值），用户保存一次所有评论锚点即报废。本函数把「文本未变」的
 * 段落恢复成上一版的 paraId（按文本对齐；被改写的段落保留新 id —— 正是漂移语义）。
 * 前置：bytes 已过 ensureDocxParaIds（每个 <w:p> 都有 id）。
 */
export function reconcileDocxIds(prev: Projection | undefined, bytes: Uint8Array): { bytes: Uint8Array; remapped: number } {
  let all: Record<string, Uint8Array>
  try { all = unzipSync(bytes) } catch { return { bytes, remapped: 0 } }
  const entry = all[DOC_XML]
  if (!entry || !prev?.nodes?.length) return { bytes, remapped: 0 }
  const xml = strFromU8(entry)

  // 扫描 w:p 段落（含表格内段落——它们的 id 同样会被 LO 重新生成）：(标签位置, id, 段内 w:t 文本)
  interface PTag { start: number; end: number; id: string; text: string }
  const tags: PTag[] = []
  {
    let tDepth = 0
    let buf: string[] = []
    let cur: { start: number; end: number; id: string } | null = null
    for (const tok of tokenize(xml)) {
      if (tok.t === 'text') { if (tDepth > 0) buf.push(decodeXml(tok.raw)); continue }
      if (tok.t === 'open') {
        if (tok.name === 'w:t') tDepth++
        else if (tok.name === 'w:p' && !cur) {
          const id = tok.attrs['w14:paraId']
          if (id) cur = { start: tok.at, end: tok.end, id }
        }
        continue
      }
      if (tok.name === 'w:t') { tDepth = Math.max(0, tDepth - 1); continue }
      if (tok.name === 'w:p' && cur) {
        tags.push({ ...cur, text: normText(buf.join('')) })
        cur = null
        buf = []
        tDepth = 0
      }
    }
  }
  if (tags.length === 0) return { bytes, remapped: 0 }

  // 与上一版 file-backed 段落做对齐匹配（窗口容忍插入）。
  const prevNodes = prev.nodes.filter(n => isFileBackedId(n.id) && normText(n.text))
  let pi = 0
  const currentTaken = new Set(tags.map(t => t.id.toLowerCase()))
  const remaps = new Map<number, string>() // tag index → prevId
  tags.forEach((t, k) => {
    const hit = (pi < prevNodes.length && prevNodes[pi]!.text === t.text)
      ? pi
      : prevNodes.findIndex((n, j) => j > pi && j <= pi + 3 && n.text === t.text)
    if (hit < 0) return
    pi = hit + 1
    const prevId = prevNodes[hit]!.id
    if (prevId.toLowerCase() === t.id) return
    if (currentTaken.has(prevId.toLowerCase())) return // 目标 id 已被占用 → 不动，避免制造重复
    remaps.set(k, prevId)
    currentTaken.delete(t.id.toLowerCase())
    currentTaken.add(prevId.toLowerCase())
  })
  if (remaps.size === 0) return { bytes, remapped: 0 }

  // 从后往前替换标签上的 id。
  let out = xml
  for (let k = tags.length - 1; k >= 0; k--) {
    const newId = remaps.get(k)
    if (!newId) continue
    const t = tags[k]!
    const tag = out.slice(t.start, t.end)
    out = out.slice(0, t.start) + tag.replace(/w14:paraId="([0-9A-Fa-f]+)"/, `w14:paraId="${newId}"`) + out.slice(t.end)
  }
  return { bytes: zipSync({ ...all, [DOC_XML]: strToU8(out) }), remapped: remaps.size }
}

/** pptx 形状 id 对齐重建：LibreOffice/Collabora 回写 pptx 时 cNvPr@id 同样全部重新生成。 */
export function reconcilePptxIds(prev: Projection | undefined, bytes: Uint8Array): { bytes: Uint8Array; remapped: number } {
  let all: Record<string, Uint8Array>
  try { all = unzipSync(bytes) } catch { return { bytes, remapped: 0 } }
  if (!prev?.slides?.length) return { bytes, remapped: 0 }
  const prevByPart = new Map(prev.slides.map(s => [s.id, s.shapes.filter(n => n.id.includes('#') && n.text)]))
  let total = 0
  const out: Record<string, Uint8Array> = { ...all }
  for (const [name, entry] of Object.entries(all)) {
    const slide = /^ppt\/slides\/slide\d+\.xml$/.exec(name)
    if (!slide) continue
    const prevShapes = prevByPart.get(name)
    if (!prevShapes?.length) continue
    const xml = strFromU8(entry!)

    // 扫描 cNvPr（形状 id 载体）+ 所属形状文本：cNv 挂在形状帧上（cNvPr 自闭合，不单独成帧）。
    interface Tag { start: number; end: number; id: string; text: string }
    const tags: Tag[] = []
    {
      let aDepth = 0
      const stack: Array<{ el: string; cNv?: { start: number; end: number; id: string }; buf: string[] }> = []
      for (const tok of tokenize(xml)) {
        if (tok.t === 'text') {
          if (aDepth > 0) {
            const top = stack[stack.length - 1]
            if (top?.cNv) top.buf.push(decodeXml(tok.raw))
          }
          continue
        }
        if (tok.t === 'open') {
          if (tok.name === 'a:t') { aDepth++; continue }
          if (tok.name === 'p:sp' || tok.name === 'p:pic' || tok.name === 'p:graphicFrame') {
            stack.push({ el: tok.name, buf: [] })
          } else if (tok.name === 'p:cNvPr' && tok.attrs.id) {
            const top = stack[stack.length - 1]
            if (top && !top.cNv) top.cNv = { start: tok.at, end: tok.end, id: tok.attrs.id }
          }
          continue
        }
        if (tok.name === 'a:t') { aDepth = Math.max(0, aDepth - 1); continue }
        if (tok.name === 'p:sp' || tok.name === 'p:pic' || tok.name === 'p:graphicFrame') {
          const frame = stack.pop()
          if (frame?.cNv) tags.push({ ...frame.cNv, text: normText(frame.buf.join('')) })
        }
      }
    }
    if (tags.length === 0) continue

    // 同页内按文本对齐（窗口容忍）。
    let pi = 0
    const currentTaken = new Set(tags.map(t => t.id))
    const remaps = new Map<number, string>()
    tags.forEach((t, k) => {
      if (!t.text) return
      const hit = (pi < prevShapes.length && normText(prevShapes[pi]!.text) === t.text)
        ? pi
        : prevShapes.findIndex((n, j) => j > pi && j <= pi + 3 && normText(n.text) === t.text)
      if (hit < 0) return
      pi = hit + 1
      const prevId = prevShapes[hit]!.id.split('#')[1]!
      if (prevId === t.id) return
      if (currentTaken.has(prevId)) return
      remaps.set(k, prevId)
      currentTaken.delete(t.id)
      currentTaken.add(prevId)
    })
    if (remaps.size === 0) continue

    let out2 = xml
    for (let k = tags.length - 1; k >= 0; k--) {
      const newId = remaps.get(k)
      if (!newId) continue
      const t = tags[k]!
      const tag = out2.slice(t.start, t.end)
      out2 = out2.slice(0, t.start) + tag.replace(/id="\d+"/, `id="${newId}"`) + out2.slice(t.end)
    }
    out[name] = strToU8(out2)
    total += remaps.size
  }
  return { bytes: total > 0 ? zipSync(out) : bytes, remapped: total }
}

// —— 极简 XML 事件流：只为读投影/扫描，不序列化 ——

type XmlToken =
  | { t: 'open'; name: string; attrs: Record<string, string>; self: boolean; at: number; end: number }
  | { t: 'close'; name: string; at: number; end: number }
  | { t: 'text'; raw: string; at: number }

function* tokenize(xml: string): Generator<XmlToken> {
  let i = 0
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) return
    if (lt > i) yield { t: 'text', raw: xml.slice(i, lt), at: i }
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt); i = e < 0 ? xml.length : e + 3; continue }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt)
      yield { t: 'text', raw: xml.slice(lt + 9, end < 0 ? xml.length : end), at: lt + 9 }
      i = end < 0 ? xml.length : end + 3
      continue
    }
    const gt = xml.indexOf('>', lt)
    if (gt < 0) return
    const tag = xml.slice(lt + 1, gt)
    if (tag.startsWith('/')) { yield { t: 'close', name: tag.slice(1).trim(), at: lt, end: gt + 1 }; i = gt + 1; continue }
    const m = /^([^\s/>]+)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)$/.exec(tag)
    const attrs: Record<string, string> = {}
    if (m?.[2]) for (const a of m[2].matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[a[1]!] = decodeXml(a[2]!)
    yield { t: 'open', name: m?.[1] ?? '', attrs, self: m?.[3] === '/', at: lt, end: gt + 1 }
    i = gt + 1
  }
}

/** docx 投影：正文标题/段落/列表/表格。表格落两个产物：合成 id 的表格 node（合并文本，供展示/diff）
 *  + 其内部段落逐个成 node（file-backed paraId，可被评论锚定）。 */
export function docxProjection(documentXml: string): ProjectionNode[] {
  const nodes: ProjectionNode[] = []
  let tbl = 0
  let sdt = 0
  let tDepth = 0
  let para: { id?: string; style?: string; numPr: boolean; buf: string[] } | null = null
  let tblBuf = ''
  let synthetic = 0

  const paraKind = (p: NonNullable<typeof para>): ProjectionNode => {
    const heading = /^Heading(\d+)$/.exec(p.style ?? '')
    const base = { id: p.id ?? `anon-${++synthetic}`, text: p.buf.join('') }
    if (heading) return { ...base, kind: 'heading', level: Number(heading[1]) }
    if (p.numPr) return { ...base, kind: 'list' }
    return { ...base, kind: 'paragraph' }
  }

  for (const tok of tokenize(documentXml)) {
    if (tok.t === 'text') {
      if (tDepth > 0) {
        if (para) para.buf.push(decodeXml(tok.raw))
        else if (tbl > 0) tblBuf += decodeXml(tok.raw)
      }
      continue
    }
    if (tok.t === 'open') {
      if (tok.name === 'w:t') tDepth++
      else if (tok.name === 'w:tab' && (para || tbl > 0) && tDepth === 0) {
        if (para) para.buf.push('\t')
        else tblBuf += '\t'
      } else if (tok.name === 'w:tbl') { tbl++; tblBuf = '' } else if (tok.name === 'w:sdt' && tbl === 0) sdt++
      else if (tok.name === 'w:p' && !para) para = { id: tok.attrs['w14:paraId'], numPr: false, buf: [] }
      else if (tok.name === 'w:pStyle' && para) para.style = tok.attrs['w:val']
      else if (tok.name === 'w:numPr' && para) para.numPr = true
      continue
    }
    // close
    if (tok.name === 'w:t') { tDepth = Math.max(0, tDepth - 1); continue }
    if (tok.name === 'w:p') {
      if (tbl === 0 && para) { nodes.push(paraKind(para)); para = null }
      else if (tbl > 0 && para) { // 表格内段落也逐个成 node（可锚定）
        const cellPara = paraKind(para)
        nodes.push(cellPara)
        tblBuf += cellPara.text
        para = null
      }
    } else if (tok.name === 'w:tc') {
      if (tbl > 0) tblBuf += ' | '
    } else if (tok.name === 'w:tr') {
      if (tbl > 0) tblBuf += '\n'
    } else if (tok.name === 'w:tbl') {
      tbl--
      if (tbl === 0) {
        const text = tblBuf.trim().replace(/\s*\|\s*(\n|$)/g, '$1').replace(/\n/g, ' / ')
        nodes.push({ id: `tbl-${++synthetic}`, kind: 'table', text })
        tblBuf = ''
      }
    } else if (tok.name === 'w:sdt' && tbl === 0 && sdt > 0) {
      sdt--
      if (sdt === 0) nodes.push({ id: `sdt-${++synthetic}`, kind: 'opaque', text: '', locked: true })
    }
  }
  return nodes
}

/** pptx 投影：逐页形状（文本/表格/图片/占位），复合 id `<part>#<cNvPr@id>`。组内形状摊平。 */
export function pptxProjection(slideXmls: Array<[string, string]>): ProjectionSlide[] {
  const slideNum = (s: string) => Number(/slide(\d+)\.xml$/.exec(s)?.[1] ?? 0)
  return [...slideXmls].sort((a, b) => slideNum(a[0]) - slideNum(b[0])).map(([part, xml], i) => {
    const shapes: ProjectionNode[] = []
    let aDepth = 0
    interface Ctx { id?: string; kind: ProjectionNodeKind; buf: string[]; geometry?: ProjectionNode['geometry'] }
    const stack: Array<{ el: string; ctx?: Ctx }> = []
    for (const tok of tokenize(xml)) {
      if (tok.t === 'text') {
        if (aDepth > 0) {
          const top = stack[stack.length - 1]
          if (top?.ctx) top.ctx.buf.push(decodeXml(tok.raw))
        }
        continue
      }
      if (tok.t === 'open') {
        if (tok.name === 'a:t') { aDepth++; continue }
        const parent = stack[stack.length - 1]?.ctx
        const isShape = tok.name === 'p:sp' || tok.name === 'p:pic' || tok.name === 'p:graphicFrame'
        // 自闭合标签不进栈（否则帧泄漏、后续 close 错位）。
        const ctx = isShape ? { kind: tok.name === 'p:pic' ? 'opaque' : 'paragraph', buf: [] } as Ctx : parent
        if (!tok.self) stack.push({ el: tok.name, ctx })
        if (!ctx) continue
        if (tok.name === 'p:cNvPr' && !ctx.id && tok.attrs.id) ctx.id = `${part}#${tok.attrs.id}`
        if (tok.name === 'a:tbl') ctx.kind = 'table'
        if (tok.name === 'a:xfrm' && tok.attrs.rot) {
          ctx.geometry ??= { x: 0, y: 0, w: 0, h: 0 }
          ctx.geometry.rot = Number(tok.attrs.rot) / 60000
        }
        if (tok.name === 'a:off') {
          ctx.geometry ??= { x: 0, y: 0, w: 0, h: 0 }
          ctx.geometry.x = Number(tok.attrs.x)
          ctx.geometry.y = Number(tok.attrs.y)
        }
        if (tok.name === 'a:ext' && ctx.geometry) {
          ctx.geometry.w = Number(tok.attrs.cx)
          ctx.geometry.h = Number(tok.attrs.cy)
        }
        continue
      }
      // close
      if (tok.name === 'a:t') { aDepth = Math.max(0, aDepth - 1); continue }
      const frame = stack.pop()
      if (!frame) continue
      if (frame.el === 'p:sp' || frame.el === 'p:pic' || frame.el === 'p:graphicFrame') {
        const ctx = frame.ctx!
        if (!ctx.id) continue
        shapes.push({
          id: ctx.id,
          kind: ctx.kind,
          text: ctx.buf.join('').trim(),
          ...(ctx.geometry ? { geometry: ctx.geometry } : {}),
        })
      }
    }
    return { id: part, index: i + 1, shapes }
  })
}

/** 按文档类型构建投影（docx 解析正文；pptx 解析全部 slide part）。非法包不抛——落版不被投影阻塞。 */
export function buildProjection(kind: 'docx' | 'pptx', bytes: Uint8Array): Projection {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, {
      filter: f => f.name === DOC_XML || /^ppt\/slides\/slide\d+\.xml$/.test(f.name),
    })
  } catch {
    return kind === 'docx' ? { nodes: [] } : { slides: [] }
  }
  if (kind === 'docx') return files[DOC_XML] ? { nodes: docxProjection(strFromU8(files[DOC_XML]!)) } : { nodes: [] }
  const slides = pptxProjection(Object.entries(files)
    .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .map(([name, data]) => [name, strFromU8(data!)] as [string, string]))
  return { slides }
}

/**
 * id 存活率（#1 验收）：上一版投影里「文本未变的节点」中，id 也保留的比例。
 * 文本变了的不计数——那可能正是本轮要求修改的内容；整体对不上（total=0）记 0，
 * 视为整文重写。
 */
export function computeIdSurvival(prev: Projection | undefined, next: Projection): number | null {
  if (!prev) return null
  const flat = (p: Projection): ProjectionNode[] => [...(p.nodes ?? []), ...(p.slides ?? []).flatMap(s => s.shapes)]
  const prevByText = new Map(flat(prev).map(n => [n.text, n.id]))
  let total = 0
  let kept = 0
  for (const n of flat(next)) {
    const pid = prevByText.get(n.text)
    if (pid === undefined) continue
    total++
    if (pid === n.id) kept++
  }
  return total === 0 ? 0 : kept / total
}

/** 用户保存的节点变更摘要（S5 三方合并的输入）：按 id 对比前后投影。 */
export function diffProjectionOps(
  prev: Projection | undefined,
  next: Projection,
): { added: string[]; removed: string[]; modified: string[] } | null {
  if (!prev) return null
  const flat = (p: Projection): ProjectionNode[] => [...(p.nodes ?? []), ...(p.slides ?? []).flatMap(s => s.shapes)]
  const prevById = new Map(flat(prev).map(n => [n.id, n]))
  const added: string[] = []
  const modified: string[] = []
  for (const n of flat(next)) {
    const p = prevById.get(n.id)
    if (!p) added.push(n.id)
    else if (p.text !== n.text) modified.push(n.id)
  }
  const nextIds = new Set(flat(next).map(n => n.id))
  const removed = flat(prev).filter(n => !nextIds.has(n.id)).map(n => n.id)
  if (added.length === 0 && removed.length === 0 && modified.length === 0) return null
  return { added, removed, modified }
}

// —— S5 三方合并的段落级手术原语（整元素拼接，未触碰内容零损失） ——

/** 定位某 paraId 的完整 <w:p> 元素（深度计数，容忍段落内嵌套 w:p，如文本框）。 */
export function paragraphSpan(xml: string, paraId: string): { start: number; end: number; element: string } | null {
  const it = tokenize(xml)
  for (const tok of it) {
    if (tok.t === 'open' && tok.name === 'w:p' && tok.attrs['w14:paraId'] === paraId) {
      let depth = 1
      for (const t2 of it) {
        if (t2.t === 'open' && t2.name === 'w:p') depth++
        else if (t2.t === 'close' && t2.name === 'w:p') {
          depth--
          if (depth === 0) return { start: tok.at, end: t2.end, element: xml.slice(tok.at, t2.end) }
        }
      }
      return null
    }
  }
  return null
}

function rewriteDocumentXml(bytes: Uint8Array, mutate: (xml: string) => string | null): Uint8Array {
  const all = unzipSync(bytes)
  const entry = all[DOC_XML]
  if (!entry) return bytes
  const next = mutate(strFromU8(entry))
  if (next === null) return bytes
  return zipSync({ ...all, [DOC_XML]: strToU8(next) })
}

/** 用 srcElement 替换目标段落（AI 对未触碰节点的修改落到用户 head 上）。 */
export function spliceReplaceParagraph(bytes: Uint8Array, paraId: string, srcElement: string): Uint8Array {
  return rewriteDocumentXml(bytes, xml => {
    const span = paragraphSpan(xml, paraId)
    if (!span) return null
    return xml.slice(0, span.start) + srcElement + xml.slice(span.end)
  })
}

/** 删除目标段落。 */
export function spliceDeleteParagraph(bytes: Uint8Array, paraId: string): Uint8Array {
  return rewriteDocumentXml(bytes, xml => {
    const span = paragraphSpan(xml, paraId)
    if (!span) return null
    return xml.slice(0, span.start) + xml.slice(span.end)
  })
}

/** 在目标段落之后插入新段落元素（AI 新增节点落到用户 head 上）。 */
export function spliceInsertAfter(bytes: Uint8Array, afterParaId: string, srcElement: string): Uint8Array {
  return rewriteDocumentXml(bytes, xml => {
    const span = paragraphSpan(xml, afterParaId)
    if (!span) return null
    return xml.slice(0, span.end) + srcElement + xml.slice(span.end)
  })
}
