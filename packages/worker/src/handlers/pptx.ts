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

/** pptxgenjs 幻灯片实例类型（模块级 — addNotesTruncated 等辅助函数共用）。 */
export type Slide = ReturnType<typeof PptxGenJSCtor.prototype.addSlide>

/** #1066-8: 单次导出内嵌图片总字节预算 — 图片以 base64 data URI 全驻留
 *  pptxgenjs（写文件前无法释放），20MB×30 页最坏 ~800MB 可致 worker OOM。
 *  超预算后跳过后续图片块（log 可观测），封顶内存峰值；仅伤恶意超大 deck
 *  的自身导出，正常 deck 远低于该阈值。可用 PPTX_IMAGE_BUDGET_BYTES 覆盖
 *  （部署调优/测试）。 */
export const MAX_EMBEDDED_IMAGE_BYTES = 100 * 1024 * 1024

/** #1066-8: 解析生效预算（env 覆盖非法值回退默认）。 */
export function resolveImageBudget(): number {
  const raw = Number(process.env.PPTX_IMAGE_BUDGET_BYTES)
  return Number.isFinite(raw) && raw > 0 ? raw : MAX_EMBEDDED_IMAGE_BYTES
}

/** #1066-8: 累计已嵌入字节 + 本张字节是否超预算。 */
export function imageBudgetExceeded(embeddedBytes: number, incomingBytes: number, budget: number = resolveImageBudget()): boolean {
  return embeddedBytes + incomingBytes > budget
}

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

/** #1062-6: notes 截断口径与 wire 统一（contracts presentationSlideSchema notes max 5000）。 */
const NOTES_MAX_CHARS = 5000

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

/** #1062-6: notes 写回统一到 wire 口径（5000 字符）——超限截断且在备注尾部
 * 加可见提示（原实现静默 slice(0,2000)，三处上限互不一致）。 */
export function addNotesTruncated(s: Slide, notes: string | undefined) {
  if (!notes) return
  const raw = String(notes)
  if (raw.length <= NOTES_MAX_CHARS) {
    s.addNotes(raw)
    return
  }
  const suffix = `……（备注超长：已截断至 ${NOTES_MAX_CHARS} 字符，源共 ${raw.length} 字符）`
  s.addNotes(raw.slice(0, Math.max(0, NOTES_MAX_CHARS - suffix.length)) + suffix)
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

  const addHeader = (s: Slide, title: string) => {
    s.background = { color: theme.bg }
    s.addText(title, { x: PAGE.margin, y: 0.35, w: bodyW, h: TITLE_H, fontSize: 26, bold: true, color: theme.text, fontFace: theme.font })
    s.addShape('rect', { x: PAGE.margin, y: 1.05, w: bodyW, h: 0.045, fill: { color: theme.accent } })
  }

  // #1066-8: 导出期累计已内嵌图片字节；超预算的后续图片块跳过（log 可观测）。
  // resolved Buffer 转 data URI 后即成为垃圾（本地引用随迭代结束释放），
  // 真正的全驻留发生在 pptxgenjs 内部 — 预算封顶是对其唯一可行的内存上界。
  let embeddedImageBytes = 0
  const addImageBounded = async (
    s: Slide,
    box: { x: number; y: number; w: number; h: number },
    img: Extract<ContentBlock, { type: 'image' }>,
  ): Promise<boolean> => {
    const resolved = await resolveImage(img)
    if (!resolved) return false
    if (imageBudgetExceeded(embeddedImageBytes, resolved.data.length)) {
      console.warn(`[PPTX] #1066-8 内嵌图片总量超预算(${Math.round(resolveImageBudget() / 1024 / 1024)}MB) — 跳过后续图片块`)
      return false
    }
    embeddedImageBytes += resolved.data.length
    // #1053: pptxgenjs addImage 仅接受 base64 字符串 — 传 Buffer 会被
    // 静默丢弃（console.error 后 return null），图根本进不了 media。
    s.addImage({ data: toBase64DataUri(resolved.data), ...box })
    return true
  }

  /** 要点渲染 + 超页自动拆续页（fitBullets 已选字号；续页同布局标题（续））。#1047: heightIn 供表格页让出下半区。
   * #1062-3: heightIn ≤ 0（表格撑满页高、无正文空间）→ 全部要点拆续页，不再静默不渲染。 */
  const renderBullets = (s: Slide, title: string, items: Array<{ text: string; bullet: boolean }>, x: number, w: number, heightIn: number = areaH) => {
    // #1063 集成收口: 空文本占位块（deck 编辑器空行）不参与渲染/占高。
    const visible = items.filter((it) => it.text && it.text.trim() !== '')
    const { font, chunks } = fitBullets(visible, w, heightIn)
    let target = s
    let cy = BODY_TOP
    // #1062-3: 当前页无正文空间 → 从续页开始渲染（此前该页要点直接消失）
    const noRoomHere = heightIn < 0.4 && visible.length > 0
    chunks.forEach((group, ci) => {
      if (ci > 0 || (noRoomHere && ci === 0)) {
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
  // #1062-5: 封面页（title 布局，由 slides[0] 合成）notes 写回 — 此前循环从
  // slice(1) 起，封面 notes 永不写入。
  if (hasTitleSlide) addNotesTruncated(cover, slides[0].notes)

  for (const slide of hasTitleSlide ? slides.slice(1) : slides) {
    const layout = layoutOf(slide)
    const s = pres.addSlide()
    // #1046: speaker notes 写回（pptxgenjs slide.addNotes → notesSlideN.xml）—
    // 导入提取的备注在导出侧不再丢失（放在 blank continue 之前，空白页也保留备注）。
    // #1062-6: 截断统一 5000 口径，截断有提示（不再静默 slice(0,2000)）。
    addNotesTruncated(s, slide.notes)
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
        // #1062-3: 行数口径统一 — 高度计算与实际渲染共用同一份 rows（此前
        // :271 用 rows.length(≤200) 算高、:273 只渲染 100 行，互不一致且
        // 截断静默）。
        const renderedRows = parsed.rows.slice(0, 100)
        if (parsed.rows.length > renderedRows.length) {
          items.push({ text: `[表格过长：仅渲染前 100 行（源共 ${parsed.rows.length} 行）]`, bullet: false })
        }
        const rowH = 0.34
        const tblH = Math.min(renderedRows.length * rowH + 0.05, Math.max(BODY_BOTTOM - tableBottom, 0.4))
        s.addTable(
          renderedRows.map((row, ri) => row.map((cell) => ({
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
      // #1062-3: 表格撑满页高（heightIn ≤ 0）→ 要点全部拆续页（此前直接不渲染）。
      if (items.length > 0) {
        renderBullets(s, slide.title, items, PAGE.margin, bodyW, Math.max(BODY_BOTTOM - tableBottom, 0))
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
        // #1066-8: 图被预算跳过（返回 false）→ 回退要点渲染，不静默空页。
        if (await addImageBounded(s, { x: 0.8, y: BODY_TOP, w: bodyW - 0.6, h: areaH - 0.2 }, img)) continue
      }
      renderBullets(s, slide.title, items, PAGE.margin, bodyW)
      continue
    }

    if (layout === 'bullets+image') {
      const img = slide.content.find(isImageBlock)
      const textW = img ? 4.4 : bodyW
      renderBullets(s, slide.title, items, PAGE.margin, textW)
      if (img) {
        // #1066-8: 同上 — 预算超限跳图可观测；要点已渲染，导出语义不变。
        await addImageBounded(s, { x: 5.2, y: BODY_TOP, w: 4.2, h: areaH - 0.2 }, img)
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
