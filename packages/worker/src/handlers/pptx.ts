import { saveFile } from '../storage.js'
import PptxGenJS from 'pptxgenjs'
import {
  SCHEMA_VERSION,
  validateRenderContent,
  type ContentBlock,
  type SlideLayout,
} from '@heurion/contracts'
import { resolveImage, toBase64DataUri } from './common.js'

const PptxGenJSCtor = PptxGenJS as unknown as new () => any

/**
 * #958 — 布局母版化渲染器。
 * v1 是写死坐标的线性堆叠器（标题 y=0.3 / 要点步进 0.55 / 图片固定 6×2.8，
 * `y > 4.8` 静默丢弃超页内容）。v2 按 contracts slideLayout 枚举渲染布局
 * 母版，theme 走统一映射表（#957），超页内容 autofit 缩字号 + 自动拆续页
 * （内容不再静默丢失）。保持纯函数语义（同输入同输出）与 legacy 入参兼容。
 */

interface GenSlide { title: string; layout?: string; notes?: string; content: ContentBlock[] }
interface GenDeck { title: string; subtitle?: string; presenter?: string; date?: string; theme?: string; slides: GenSlide[] }

/** 主题映射表（#957 受控枚举）— clinical 维持 v1 观感，warm-paper 为 DESIGN_SYSTEM_v2 方向（#944 联动）。 */
const THEMES: Record<string, { bg: string; text: string; muted: string; accent: string; accentSoft: string; font: string }> = {
  clinical: { bg: 'FFFFFF', text: '1F2937', muted: '6B7280', accent: '0284C7', accentSoft: 'E0F2FE', font: 'Calibri' },
  'warm-paper': { bg: 'FAF7F2', text: '2F3437', muted: '6B6B60', accent: '2F4F47', accentSoft: 'E7EDE8', font: 'Georgia' },
}

const SLIDE_LAYOUTS: ReadonlySet<string> = new Set(['title', 'section', 'bullets', 'bullets+image', 'chart-full', 'quote', 'blank'])

/** 画布几何（WIDE 10 × 5.625 in）。 */
const PAGE = { w: 10, h: 5.625, margin: 0.5 }
const TITLE_H = 0.8
const BODY_TOP = 1.25
const BODY_BOTTOM = 5.15
const MIN_FONT = 11
const FONT_LADDER = [16, 14, 12, MIN_FONT]

function layoutOf(slide: { layout?: string }): SlideLayout {
  return SLIDE_LAYOUTS.has(String(slide.layout)) ? (slide.layout as SlideLayout) : 'bullets'
}

function themeOf(name?: string) {
  return THEMES[String(name || '')] ?? THEMES.clinical
}

/** 视觉长度：CJK 宽字符按 2 计。 */
function visualLen(text: string): number {
  return [...text].reduce((n, ch) => n + (ch.codePointAt(0)! > 0x2e80 ? 2 : 1), 0)
}

/** 行高估算（in）：行宽英寸 → 字符容量（≈ fontSize*0.6px @96dpi）。 */
function estHeight(text: string, fontSize: number, widthIn: number): number {
  const charsPerLine = Math.max(6, Math.floor((widthIn * 96) / (fontSize * 0.6)))
  const lines = Math.max(1, Math.ceil(visualLen(text) / charsPerLine))
  return (lines * fontSize * 1.32) / 72
}

function isImageBlock(b: ContentBlock): b is Extract<ContentBlock, { type: 'image' }> {
  return b.type === 'image'
}

function bulletItems(blocks: ContentBlock[]): Array<{ text: string; bullet: boolean }> {
  return blocks
    .filter((b) => b.type === 'paragraph')
    .map((b) => ({ text: String((b as { text?: string }).text || ''), bullet: (b as { style?: string }).style === 'bullet' }))
}

/** 要点 autofit：字号候选递减取首个单页放下者；仍超页则拆续页（内容不再静默丢失）。 */
function fitBullets(items: Array<{ text: string; bullet: boolean }>, widthIn: number, heightIn: number): { font: number; chunks: Array<Array<{ text: string; bullet: boolean }>> } {
  const chunk = (font: number): Array<Array<{ text: string; bullet: boolean }>> => {
    const chunks: Array<Array<{ text: string; bullet: boolean }>> = [[]]
    let used = 0
    for (const it of items) {
      const h = estHeight(it.text, font, widthIn) + 0.12
      if (used + h > heightIn && chunks[chunks.length - 1].length > 0) {
        chunks.push([it])
        used = h
      } else {
        chunks[chunks.length - 1].push(it)
        used += h
      }
    }
    return chunks
  }
  for (const font of FONT_LADDER) {
    const chunks = chunk(font)
    if (chunks.length === 1) return { font, chunks }
  }
  return { font: MIN_FONT, chunks: chunk(MIN_FONT) }
}

/** table 块 data 解析（#1047）— JSON 字符串 `{rows: string[][], header?: boolean}`；畸形返回 null。 */
function parseTableBlockData(raw: unknown): { rows: string[][]; header: boolean } | null {
  if (typeof raw !== 'string') return null
  try {
    const v = JSON.parse(raw) as { rows?: unknown; header?: unknown }
    if (!Array.isArray(v.rows) || v.rows.length === 0) return null
    const rows = v.rows
      .filter((r): r is unknown[] => Array.isArray(r))
      .slice(0, 200)
      .map((r) => r.slice(0, 30).map((c) => String(c ?? '').slice(0, 2000)))
    return { rows, header: v.header === true }
  } catch {
    return null
  }
}

/** #1050: markdown 行内标记 → rich-text runs（bold/italic/strike/link）。
 * 最小单层解析（不处理嵌套/转义），首尾空白不进标记（CommonMark 语义）；
 * 链接 URL 仅接受 http(s)，避免对普通文案里的方括号误判。
 * #1054: <u> 下划线直通（与正文/deck 同款 GitHub 方案）— 内容只匹配纯文本
 * （[^<]+，不进嵌套标签），带属性（<u …>）或未闭合不成对 → 不匹配，原样纯文本。
 * 无标记文本返回单 run 且无样式 → 调用方保持与改动前完全一致的纯文本路径。 */
export interface InlineRun {
  text: string
  bold?: boolean
  italic?: boolean
  strike?: boolean
  underline?: boolean
  link?: string
}

const INLINE_MD_RE = /\*\*([^*\s](?:[^*]*[^*\s])?)\*\*|\*([^*\s](?:[^*]*[^*\s])?)\*|~~([^~\s](?:[^~]*[^~\s])?)~~|\[([^\]]+)\]\((https?:\/\/[^()\s]+)\)|<u>([^<]+)<\/u>/g

export function parseInlineMarkdown(text: string): InlineRun[] {
  const runs: InlineRun[] = []
  if (!text) return runs
  let last = 0
  for (const m of text.matchAll(INLINE_MD_RE)) {
    const start = m.index ?? 0
    if (start > last) runs.push({ text: text.slice(last, start) })
    if (m[1] !== undefined) runs.push({ text: m[1], bold: true })
    else if (m[2] !== undefined) runs.push({ text: m[2], italic: true })
    else if (m[3] !== undefined) runs.push({ text: m[3], strike: true })
    else if (m[4] !== undefined && m[5]) runs.push({ text: m[4], link: m[5] })
    else if (m[6] !== undefined) runs.push({ text: m[6], underline: true })
    last = start + m[0].length
  }
  if (last < text.length) runs.push({ text: text.slice(last) })
  return runs
}

/** #1050: 文本 → pptxgenjs text 数组（runs）或原字符串。
 * 仅当解析出真实标记时才切 runs；否则返回原字符串，渲染与改动前逐字节一致（回归用例 4）。 */
function toRunsOrString(text: string): string | Array<{ text: string; options: Record<string, unknown> }> {
  const runs = parseInlineMarkdown(text)
  if (runs.length === 0) return text
  if (!runs.some((r) => r.bold || r.italic || r.strike || r.underline || r.link)) return text
  return runs.map((r) => ({
    text: r.text,
    options: {
      ...(r.bold ? { bold: true } : {}),
      ...(r.italic ? { italic: true } : {}),
      ...(r.strike ? { strike: true } : {}),
      // #1054: pptxgenjs v3.5+ 下划线走对象形态（style: 'sng'）。
      ...(r.underline ? { underline: { style: 'sng' } } : {}),
      ...(r.link ? { hyperlink: { url: r.link } } : {}),
    },
  }))
}

export async function generatePptx(payload: any) {
  // The server now sends { schema_version, content_type, data: {schemaVersion,...} }.
  // Accept the legacy { template_id, data: {...} } and flat shapes too.
  let raw = payload?.data ?? payload
  if (raw && typeof raw === 'object' && 'content_type' in payload && !('slides' in raw)) {
    raw = payload.data
  }
  const check = validateRenderContent('sidecar.generate_pptx', raw)
  const input = (check.ok
    ? check.data
    : {
        title: String(raw?.title || 'Presentation'),
        subtitle: undefined,
        presenter: undefined,
        theme: undefined,
        slides: [{ title: '内容', content: [{ type: 'paragraph', text: String(raw?.data?.slides?.[0]?.content || '') }] }],
      }) as unknown as GenDeck

  const theme = THEMES[String(input.theme || '')] ?? THEMES.clinical
  const pres = new PptxGenJSCtor()
  pres.defineLayout({ name: 'WIDE', width: PAGE.w, height: PAGE.h })
  pres.layout = 'WIDE'

  const bodyW = PAGE.w - PAGE.margin * 2
  const areaH = BODY_BOTTOM - BODY_TOP

  type Slide = ReturnType<typeof PptxGenJSCtor.prototype.addSlide>
  const addHeader = (s: Slide, title: string) => {
    s.background = { color: theme.bg }
    s.addText(title, { x: PAGE.margin, y: 0.35, w: bodyW, h: TITLE_H, fontSize: 26, bold: true, color: theme.text, fontFace: theme.font })
    s.addShape('rect', { x: PAGE.margin, y: 1.05, w: bodyW, h: 0.045, fill: { color: theme.accent } })
  }

  /** 要点渲染 + 超页自动拆续页（fitBullets 已选字号；续页同布局标题（续））。#1047: heightIn 供表格页让出下半区。 */
  const renderBullets = (s: Slide, title: string, items: Array<{ text: string; bullet: boolean }>, x: number, w: number, heightIn: number = areaH) => {
    const { font, chunks } = fitBullets(items, w, heightIn)
    let target = s
    let cy = BODY_TOP
    chunks.forEach((group, ci) => {
      if (ci > 0) {
        target = pres.addSlide()
        addHeader(target, `${title}（续）`)
        cy = BODY_TOP
      }
      for (const it of group) {
        // #1050: 行内标记 → rich-text runs（真实粗体/斜体/删除线/超链接，非图片）；
        // 无标记纯文本走原字符串路径，渲染与改动前完全一致。
        target.addText(toRunsOrString(it.text), {
          x, y: cy, w, h: Math.max(estHeight(it.text, font, w), 0.34), fontSize: font, valign: 'top', breakLine: false,
          color: theme.text, fontFace: theme.font,
          ...(it.bullet ? { bullet: true, bulletColor: theme.accent } : {}),
        })
        cy += estHeight(it.text, font, w) + 0.1
      }
    })
  }

  /** 封面：显式 title 布局页优先，否则合成（v1 行为保持）。 */
  const slides = input.slides || []
  const hasTitleSlide = slides.length > 0 && layoutOf(slides[0]) === 'title'
  const cover = pres.addSlide()
  cover.background = { color: theme.bg }
  cover.addText(hasTitleSlide ? slides[0].title : input.title, { x: 0.5, y: 1.5, w: 9, h: 1, fontSize: 32, bold: true, align: 'center', color: theme.text, fontFace: theme.font })
  const coverSub = [
    input.subtitle || '',
    input.presenter || '',
    ...(hasTitleSlide ? slides[0].content.filter((b) => b.type === 'paragraph').map((b) => String((b as { text?: string }).text || '')) : []),
  ].filter(Boolean).join(' · ')
  if (coverSub) {
    cover.addText(coverSub, { x: 0.5, y: 2.7, w: 9, h: 0.6, fontSize: 16, align: 'center', color: theme.muted, fontFace: theme.font })
  }

  for (const slide of hasTitleSlide ? slides.slice(1) : slides) {
    const layout = layoutOf(slide)
    const s = pres.addSlide()
    // #1046: speaker notes 写回（pptxgenjs slide.addNotes → notesSlideN.xml）—
    // 导入提取的备注在导出侧不再丢失（放在 blank continue 之前，空白页也保留备注）。
    if (slide.notes) s.addNotes(String(slide.notes).slice(0, 2000))
    if (layout === 'blank') continue // 空白页：仅母版底色

    addHeader(s, slide.title)
    const items = slide.content
      .filter((b) => b.type === 'paragraph')
      .map((b) => ({ text: String((b as { text?: string }).text || ''), bullet: (b as { style?: string }).style === 'bullet' }))
    // #960 防御：chart/figure 块应已在服务端导出边界转为 image；此处兜底
    // 渲染为文本摘要，不再静默跳过（#958 无静默丢内容口径）。
    for (const b of slide.content) {
      if (b.type === 'chart') {
        const spec = (b as { spec?: { title?: string; data?: Array<{ label: string; value: number }> } }).spec
        const rows = (spec?.data || []).slice(0, 6).map((d) => `${d.label}: ${d.value}`).join('；')
        items.push({ text: `[图表] ${spec?.title || ''} ${rows}`.trim(), bullet: false })
      } else if (b.type === 'figure') {
        items.push({ text: `[图形] ${(b as { source?: string }).source?.slice(0, 60) || ''}`, bullet: false })
      }
    }
    const firstPara = items[0]?.text || ''

    // #1047: 表格块 → pptxgenjs 原生表格对象（a:tbl graphicFrame，非图片）。
    // 表格占上半区、要点渲染到表格下方（空间不足由 fitBullets 拆续页兜底）；
    // data 畸形（非约定 JSON）→ 跳过该表格，不中断整份导出。
    const tableBlocks = slide.content.filter((b) => b.type === 'table')
    if (tableBlocks.length > 0) {
      let tableBottom = BODY_TOP
      for (const tb of tableBlocks.slice(0, 2)) {
        const parsed = parseTableBlockData((tb as { data?: unknown }).data)
        if (!parsed || parsed.rows.length === 0) continue
        const rowH = 0.34
        const tblH = Math.min(parsed.rows.length * rowH + 0.05, Math.max(BODY_BOTTOM - tableBottom, 0.4))
        s.addTable(
          parsed.rows.slice(0, 100).map((row, ri) => row.map((cell) => ({
            text: cell,
            options: {
              fontSize: 12,
              valign: 'middle' as const,
              ...(parsed.header && ri === 0 ? { bold: true, fill: { color: theme.accentSoft }, color: theme.text } : {}),
            },
          }))),
          { x: PAGE.margin, y: tableBottom, w: bodyW, rowH, border: { pt: 0.5, color: '94A3B8' }, fontFace: theme.font, autoPage: false },
        )
        tableBottom += tblH + 0.25
      }
      if (items.length > 0 && tableBottom < BODY_BOTTOM) {
        renderBullets(s, slide.title, items, PAGE.margin, bodyW, BODY_BOTTOM - tableBottom)
      }
      continue
    }

    if (layout === 'section') {
      s.background = { color: theme.accentSoft }
      s.addText(slide.title, { x: 0.8, y: 2.0, w: bodyW - 0.6, h: 1.2, fontSize: 34, bold: true, color: theme.accent, fontFace: theme.font, align: 'center' })
      if (firstPara) s.addText(firstPara, { x: 0.8, y: 3.3, w: bodyW - 0.6, h: 0.8, fontSize: 14, color: theme.muted, fontFace: theme.font, align: 'center' })
      continue
    }

    if (layout === 'quote') {
      s.addText(firstPara || slide.title, { x: 0.9, y: 1.6, w: bodyW - 0.8, h: 2.2, fontSize: 20, italic: true, color: theme.text, fontFace: theme.font, align: 'center', valign: 'middle' })
      if (items.length > 1 || firstPara) {
        s.addText(slide.title, { x: 0.9, y: 3.9, w: bodyW - 0.8, h: 0.5, fontSize: 13, color: theme.muted, align: 'center' })
      }
      continue
    }

    if (layout === 'chart-full') {
      const img = slide.content.find(isImageBlock)
      if (img) {
        const resolved = await resolveImage(img)
        if (resolved) {
          // #1053: pptxgenjs addImage 仅接受 base64 字符串 — 传 Buffer 会被
          // 静默丢弃（console.error 后 return null），图根本进不了 media。
          s.addImage({ data: toBase64DataUri(resolved.data), x: 0.8, y: BODY_TOP, w: bodyW - 0.6, h: areaH - 0.2 })
          continue
        }
      }
      renderBullets(s, slide.title, items, PAGE.margin, bodyW)
      continue
    }

    if (layout === 'bullets+image') {
      const img = slide.content.find(isImageBlock)
      const textW = img ? 4.4 : bodyW
      renderBullets(s, slide.title, items, PAGE.margin, textW)
      if (img) {
        const resolved = await resolveImage(img)
        // #1053: 同上 — Buffer → base64 data URI，否则 addImage 静默丢图。
        if (resolved) s.addImage({ data: toBase64DataUri(resolved.data), x: 5.2, y: BODY_TOP, w: 4.2, h: areaH - 0.2 })
      }
      continue
    }

    renderBullets(s, slide.title, items, PAGE.margin, bodyW)
  }

  const buffer = Buffer.from(await pres.write({ outputType: 'nodebuffer' }))
  return saveFile(buffer, 'presentation.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
}

// SCHEMA_VERSION 仍由 validateRenderContent 内部消费（导入保留以维持契约口径显式化）。
void SCHEMA_VERSION
