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
const DOC_XML = 'word/document.xml'

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

// —— 极简 XML 事件流：只为读投影，不序列化 ——

type XmlToken =
  | { t: 'open'; name: string; attrs: Record<string, string>; self: boolean }
  | { t: 'close'; name: string }
  | { t: 'text'; raw: string }

function* tokenize(xml: string): Generator<XmlToken> {
  let i = 0
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) return
    if (lt > i) yield { t: 'text', raw: xml.slice(i, lt) }
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt); i = e < 0 ? xml.length : e + 3; continue }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt)
      yield { t: 'text', raw: xml.slice(lt + 9, end < 0 ? xml.length : end) }
      i = end < 0 ? xml.length : end + 3
      continue
    }
    const gt = xml.indexOf('>', lt)
    if (gt < 0) return
    const tag = xml.slice(lt + 1, gt)
    if (tag.startsWith('/')) { yield { t: 'close', name: tag.slice(1).trim() }; i = gt + 1; continue }
    const m = /^([^\s/>]+)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)$/.exec(tag)
    const attrs: Record<string, string> = {}
    if (m?.[2]) for (const a of m[2].matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[a[1]!] = decodeXml(a[2]!)
    yield { t: 'open', name: m?.[1] ?? '', attrs, self: m?.[3] === '/' }
    i = gt + 1
  }
}

/** docx 投影：正文标题/段落/列表/表格。表格 node 的 id 是合成的（tbl-N）——表格锚点一律落在其内部段落的 paraId 上。 */
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
      else if (tok.name === 'w:p' && tbl === 0 && !para) para = { id: tok.attrs['w14:paraId'], numPr: false, buf: [] }
      else if (tok.name === 'w:pStyle' && para) para.style = tok.attrs['w:val']
      else if (tok.name === 'w:numPr' && para) para.numPr = true
      continue
    }
    // close
    if (tok.name === 'w:t') { tDepth = Math.max(0, tDepth - 1); continue }
    if (tok.name === 'w:p') {
      if (tbl === 0 && para) { nodes.push(paraKind(para)); para = null }
    } else if (tok.name === 'w:tc') {
      if (tbl > 0) tblBuf += ' | '
    } else if (tok.name === 'w:tr') {
      if (tbl > 0) tblBuf += '\n'
    } else if (tok.name === 'w:tbl') {
      tbl--
      if (tbl === 0) {
        const text = tblBuf.trim().replace(/\s*\|\s*(\n|$)/g, '$1')
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
