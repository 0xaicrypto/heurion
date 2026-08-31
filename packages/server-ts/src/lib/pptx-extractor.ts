import { readZipEntries, ZipReadError } from './zip-reader.js'
import { safeUploadPath } from './upload-path.js'
import type { ExtractedPdfImage } from './document-extractor.js'

/**
 * #777 — pptx 解析导入：pptx（zip + OOXML）→ slides 结构 + 内嵌图。
 *
 * 与 export 互为镜像（epic #775 三轮走查）：`ppt/slides/slideN.xml` 按页
 * 提取占位符文本（`<a:t>` 文本串）→ `{ slides: [{ title, paragraphs }] }`
 * 天然对齐 presentationContentSchema（deck 落点），同时渲染 markdown
 * （`## 页标题` + 正文，文章落点）。
 *
 * 安全（不可信 XML/zip，五轮走查）：
 *   - zip 炸弹：zip-reader 条目数/解压总量上限；
 *   - XXE：不使用任何 XML 解析器 — 文本提取为正则收集 `<a:t>` 内容 +
 *     基本实体解码，不存在外部实体解析路径；
 *   - 加密 zip：zip-reader 抛可读错误。
 *
 * 解析边界（首版降级策略 — 绝不静默丢内容）：表格（`<a:tbl>`）、图表
 * （chart part）、SmartArt（`<dgm:`）不解析，输出占位注记；speaker
 * notes（notesSlideN.xml）提取为页备注。页序优先 presentation.xml 的
 * sldIdLst（权威顺序），缺失/损坏时按文件名自然排序兜底。
 */

export interface PptxSlide {
  title: string
  paragraphs: string[]
  /** speaker notes（可选提取，演示场景有价值）。 */
  notes?: string
}

export interface PptxParseResult {
  ok: boolean
  /** 解析失败时的可读原因（损坏/加密/空结构）。 */
  error?: string
  slides: PptxSlide[]
  images: ExtractedPdfImage[]
}

export const PPTX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

/** 上限（五轮走查约束：≤100 页；图片沿用 PDF 提取限额口径）。 */
const MAX_SLIDES = 100
const MAX_MEDIA_FILES = 24
const MAX_MEDIA_FILE_BYTES = 4 * 1024 * 1024
const MAX_SLIDE_TEXT_CHARS = 20000

export function isPptx(filename: string, mimeType?: string): boolean {
  const lower = filename.toLowerCase()
  return lower.endsWith('.pptx') || mimeType === PPTX_MIME_TYPE
}

/** XML 文本节点实体解码（最小集 — `<a:t>` 内出现的是 XML 预定义实体）。 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
}

/** 一个 shape（`<p:sp>`）内的段落列表：按 `<a:p>` 分段、段内拼接 `<a:t>`。 */
function paragraphsFromShape(spXml: string): string[] {
  const paragraphs: string[] = []
  const paraRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g
  let m: RegExpExecArray | null
  while ((m = paraRe.exec(spXml)) !== null) {
    const runs: string[] = []
    const runRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g
    let r: RegExpExecArray | null
    while ((r = runRe.exec(m[1])) !== null) runs.push(decodeXmlEntities(r[1]))
    const text = runs.join('').replace(/\s+/g, ' ').trim()
    if (text) paragraphs.push(text)
  }
  return paragraphs
}

function isTitleShape(spXml: string): boolean {
  return /<p:ph[^>]*\stype="(title|ctrTitle)"/.test(spXml)
}

/** graphicFrame 里的复杂对象 → 占位注记（表格/图表/SmartArt）。 */
function noteFromGraphicFrame(frameXml: string): string | null {
  if (/<a:tbl[\s>]/.test(frameXml)) return '[本页含表格，未解析]'
  if (/<c:chart[\s/>]/.test(frameXml)) return '[本页含图表，未解析]'
  if (/<dgm:/.test(frameXml)) return '[本页含 SmartArt，未解析]'
  return null
}

/** slide XML → { title, paragraphs }。 */
function parseSlideXml(xml: string, slideIndex: number): PptxSlide {
  let title = ''
  const paragraphs: string[] = []
  let budget = MAX_SLIDE_TEXT_CHARS

  const pushTexts = (texts: string[]) => {
    for (const t of texts) {
      if (budget <= 0) return
      const piece = t.slice(0, budget)
      budget -= piece.length
      paragraphs.push(piece)
    }
  }

  // 1) 形状（<p:sp>）：title 占位符 → 页标题；其余 → 正文段落。
  const shapeRe = /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g
  let m: RegExpExecArray | null
  while ((m = shapeRe.exec(xml)) !== null) {
    const spXml = m[1]
    if (isTitleShape(spXml) && !title) {
      const paras = paragraphsFromShape(spXml)
      if (paras.length > 0) {
        title = paras.join(' ').slice(0, 500)
        continue
      }
    }
    pushTexts(paragraphsFromShape(spXml))
  }

  // 2) 复杂对象（<p:graphicFrame>）：表格/图表/SmartArt 占位注记。
  const frameRe = /<p:graphicFrame\b[^>]*>([\s\S]*?)<\/p:graphicFrame>/g
  while ((m = frameRe.exec(xml)) !== null) {
    const note = noteFromGraphicFrame(m[1])
    if (note) pushTexts([note])
  }

  return { title: title || `第 ${slideIndex} 页`, paragraphs }
}

/** notesSlide XML → 纯文本（有界，只取 body 占位符 — 跳过页码占位）。 */
function parseNotesXml(xml: string): string {
  const texts: string[] = []
  const shapeRe = /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g
  let m: RegExpExecArray | null
  while ((m = shapeRe.exec(xml)) !== null) {
    if (!/<p:ph[^>]*\stype="body"/.test(m[1])) continue
    texts.push(...paragraphsFromShape(m[1]))
  }
  return texts.join(' ').slice(0, 2000)
}

/** slideN.xml.rels → 该页引用的 media 文件名（去重）。 */
function mediaFromSlideRels(relsXml: string): string[] {
  const names: string[] = []
  const relRe = /<Relationship\b[^>]*Target="([^"]*media\/[^"]*)"[^>]*\/?>/g
  let m: RegExpExecArray | null
  while ((m = relRe.exec(relsXml)) !== null) {
    const base = m[1].split('/').pop() || ''
    if (base) names.push(base)
  }
  return names
}

/** presentation.xml + rels → 权威页序（slide 文件名列表）；失败返回 null。 */
function orderedSlideNames(entries: Map<string, Buffer>): string[] | null {
  try {
    const presXml = entries.get('ppt/presentation.xml')?.toString('utf-8')
    const relsXml = entries.get('ppt/_rels/presentation.xml.rels')?.toString('utf-8')
    if (!presXml || !relsXml) return null
    const ridToTarget = new Map<string, string>()
    const relRe = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]*slides\/[^"]*)"[^>]*\/?>/g
    let m: RegExpExecArray | null
    while ((m = relRe.exec(relsXml)) !== null) {
      const base = m[2].split('/').pop() || ''
      if (base) ridToTarget.set(m[1], `ppt/slides/${base}`)
    }
    const ordered: string[] = []
    const sldRe = /<p:sldId\b[^>]*r:id="([^"]+)"/g
    while ((m = sldRe.exec(presXml)) !== null) {
      const target = ridToTarget.get(m[1])
      if (target && entries.has(target)) ordered.push(target)
    }
    return ordered.length > 0 ? ordered : null
  } catch {
    return null
  }
}

/**
 * 解析 pptx 字节流。任何失败都以 { ok:false, error } 返回（可读、可引导），
 * 绝不抛出 — 上传/导入管线据此降级，不产生半截导入。
 */
export function parsePptx(buffer: Buffer): PptxParseResult {
  const fail = (error: string): PptxParseResult => ({ ok: false, error, slides: [], images: [] })
  let entriesMap: Map<string, Buffer>
  try {
    const entries = readZipEntries(buffer, {
      maxEntries: 3000,
      maxTotalUncompressed: 300 * 1024 * 1024,
      // 只解压文本/关系/媒体 — 其余（fonts/embeddings/thumbnails）跳过。
      filter: (name) => /^(ppt\/slides\/slide\d+\.xml|ppt\/slides\/_rels\/|ppt\/notesSlides\/|ppt\/media\/|ppt\/presentation\.xml|ppt\/_rels\/presentation\.xml\.rels)/.test(name),
    })
    entriesMap = new Map(entries.map((e) => [e.name, e.data]))
  } catch (err) {
    if (err instanceof ZipReadError) return fail(`无法解析 PPTX：${err.message}`)
    return fail(`无法解析 PPTX：${(err as Error).message.slice(0, 120)}`)
  }

  // 页序：presentation.xml sldIdLst 权威序 → 文件名自然序兜底。
  const natural = [...entriesMap.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (parseInt(a.replace(/\D+/g, ''), 10) || 0) - (parseInt(b.replace(/\D+/g, ''), 10) || 0))
  const slideNames = orderedSlideNames(entriesMap) ?? natural
  if (slideNames.length === 0) return fail('无法解析 PPTX：未找到幻灯片内容（文件损坏或不是有效的 PowerPoint 文件）')

  const mediaEntries = new Map<string, Buffer>()
  for (const [name, data] of entriesMap) {
    if (name.startsWith('ppt/media/') && data.length <= MAX_MEDIA_FILE_BYTES) {
      mediaEntries.set(name.slice('ppt/media/'.length), data)
    }
  }

  const slides: PptxSlide[] = []
  const images: ExtractedPdfImage[] = []
  for (let i = 0; i < Math.min(slideNames.length, MAX_SLIDES); i++) {
    const slideName = slideNames[i]
    const xml = entriesMap.get(slideName)?.toString('utf-8') || ''
    const slide = parseSlideXml(xml, i + 1)
    // speaker notes（notesSlideN.xml，可选）— 页号与 slide 序号对齐。
    const notesXml = entriesMap.get(`ppt/notesSlides/notesSlide${i + 1}.xml`)?.toString('utf-8')
    if (notesXml) {
      const notes = parseNotesXml(notesXml)
      if (notes) slide.notes = notes
    }
    // 该页引用的图片（按 rels → media 落位，页号 = 页码，供 markdown 分页嵌图）。
    const relsXml = entriesMap.get(`ppt/slides/_rels/${slideName.split('/').pop()}.rels`)?.toString('utf-8') || ''
    for (const mediaName of mediaFromSlideRels(relsXml)) {
      const data = mediaEntries.get(mediaName)
      if (!data || images.length >= MAX_MEDIA_FILES) continue
      const ext = mediaName.split('.').pop()?.toLowerCase() || ''
      if (!['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) continue
      images.push({ mime: mimeFromExt(ext), dataBase64: data.toString('base64'), page: i + 1 })
    }
    slides.push(slide)
  }
  if (slides.length === 0) return fail('无法解析 PPTX：未提取到任何页面内容')
  return { ok: true, slides, images }
}

function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  }
  return map[ext] || 'image/png'
}

/** deck 落点：slides → presentationContent（契约模型，#773 的 Doc.deck）。 */
export function pptxSlidesToDeck(slides: PptxSlide[], images: ExtractedPdfImage[], title: string, schemaVersion: number): { schemaVersion: number; title: string; slides: Array<{ title: string; content: Array<Record<string, unknown>> }> } | null {
  if (slides.length === 0) return null
  const byPage = new Map<number, ExtractedPdfImage[]>()
  for (const img of images) {
    const list = byPage.get(img.page) || []
    list.push(img)
    byPage.set(img.page, list)
  }
  const deckSlides = slides.slice(0, 30).map((s, i) => {
    const content: Array<Record<string, unknown>> = []
    for (const p of s.paragraphs.slice(0, 50)) {
      content.push({ type: 'paragraph', text: p.slice(0, 2000), style: 'bullet' })
    }
    for (const img of (byPage.get(i + 1) || []).slice(0, 3)) {
      content.push({ type: 'image', ref: `pptx-media-${i + 1}-${content.length}`, data: img.dataBase64, caption: `图 ${i + 1}` })
    }
    if (content.length === 0) content.push({ type: 'paragraph', text: '（本页待补充）', style: 'normal' })
    return { title: s.title.slice(0, 500), content }
  })
  return { schemaVersion, title: (title || 'Presentation').slice(0, 500), slides: deckSlides }
}

/** 文章落点：slides → markdown（`##` 分节 + 页标记供 embedDocumentImages 嵌图）。 */
export function pptxSlidesToMarkdown(result: PptxParseResult): string {
  const parts: string[] = []
  result.slides.forEach((s, i) => {
    parts.push(`## ${s.title}`)
    for (const p of s.paragraphs) parts.push(p)
    parts.push('')
    parts.push(`<!-- page:${i + 1} -->`)
    parts.push('')
  })
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 从 uploads 读取并解析 pptx（供后台 deck 落点与导入管线共用）。 */
export function extractPptxContentFromUpload(userId: string, fileId: string): { text: string; slides: PptxSlide[]; images: ExtractedPdfImage[]; error?: string } {
  const filepath = safeUploadPath(userId, fileId)
  if (!filepath) return { text: '', slides: [], images: [], error: '上传文件不存在' }
  let buffer: Buffer
  try {
    buffer = require('fs').readFileSync(filepath)
  } catch {
    return { text: '', slides: [], images: [], error: '上传文件不存在' }
  }
  const parsed = parsePptx(buffer)
  if (!parsed.ok) return { text: '', slides: [], images: [], error: parsed.error }
  return { text: pptxSlidesToMarkdown(parsed), slides: parsed.slides, images: parsed.images }
}
