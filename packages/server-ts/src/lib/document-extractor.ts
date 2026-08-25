import fs from 'fs'
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { PDFParse } from 'pdf-parse'
import { createWorker, type Worker } from 'tesseract.js'
import sharp from 'sharp'
import { safeUploadPath } from './upload-path.js'

export interface ExtractOptions {
  maxChars?: number
  ocrPageLimit?: number
  ocrScale?: number
}

const OCR_TEXT_THRESHOLD = 100
const DEFAULT_OCR_PAGE_LIMIT = 5
const DEFAULT_OCR_SCALE = 2

// #fix: pdf.js 解析大文件内存峰值可达文件体积的数倍到数十倍,超大 PDF
// 会把 Node 进程打爆(OOM kill) — 所有进行中的 SSE 连接随之被重置,前端
// 表现为 "TypeError: network error"。按体积分档解析:
//   ≤50MB            全量解析(原有行为)
//   50–150MB         只解析前 MAX_TEXT_PAGES 页 — pdf.js partial 仅物化
//                    所选页,内存 ≈ 文件缓冲 + 所选页,不再随总页数膨胀
//   >150MB           跳过(提取上限 300K 字符,大书无论如何都会在字符层截断)
const PAGE_LIMITED_PARSE_BYTES = 50 * 1024 * 1024
const MAX_EXTRACT_FILE_BYTES = 150 * 1024 * 1024
const MAX_TEXT_PAGES = 30

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/**
 * #fix(参考 opencode util/media.ts):magic bytes 嗅探真实文件类型 —
 * 扩展名可伪造/缺失(如把 PDF 改名 .txt 或去掉扩展名),按扩展名判定会
 * 走错解析路径(文本解码出乱码)。读文件头前几个字节判定,扩展名兜底。
 */
export function sniffDocumentMime(buffer: Uint8Array): string | null {
  const startsWith = (prefix: number[]) => prefix.every((v, i) => buffer[i] === v)
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (startsWith([0x42, 0x4d])) return 'image/bmp'
  // RIFF....WEBP — webp 是 RIFF 容器,"WEBP" 写在偏移 8 处。
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && buffer.length >= 12) {
    const webp = [0x57, 0x45, 0x42, 0x50]
    if (webp.every((v, i) => buffer[8 + i] === v)) return 'image/webp'
  }
  // PK\x03\x04 / PK\x05\x06 / PK\x07\x08 — zip 容器(docx/xlsx/pptx 共用,
  // 具体格式仍需扩展名或内容判定,mammoth 解析失败会回退)。
  if (startsWith([0x50, 0x4b, 0x03, 0x04]) || startsWith([0x50, 0x4b, 0x05, 0x06]) || startsWith([0x50, 0x4b, 0x07, 0x08])) return 'application/zip'
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'
  return null
}

/**
 * #511: image attachment detection — bitmap images (png/jpg/jpeg/gif/webp)
 * travel as multimodal image parts; SVG is text-readable XML so it stays on
 * the text path.
 */
export function isImageFile(filename: string, mimeType?: string): boolean {
  const lower = filename.toLowerCase()
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(lower)) return true
  if (mimeType && (mimeType.startsWith('image/')) && !mimeType.includes('svg')) return true
  return false
}

export function isDocx(filename: string, mimeType?: string): boolean {
  const lower = filename.toLowerCase()
  return lower.endsWith('.docx') || mimeType === DOCX_MIME_TYPE
}

export function isPdf(filename: string, mimeType?: string): boolean {
  const lower = filename.toLowerCase()
  return lower.endsWith('.pdf') || mimeType === 'application/pdf'
}

function isText(filename: string, mimeType?: string): boolean {
  const lower = filename.toLowerCase()
  const textLike = /\.(txt|md|markdown|csv|json|yaml|yml|xml|html|htm|ts|js|tsx|jsx|py|sql|log)$/i
  if (textLike.test(lower)) return true
  if (mimeType) {
    return (
      mimeType.startsWith('text/') ||
      mimeType === 'application/json' ||
      mimeType === 'application/xml' ||
      mimeType === 'application/javascript' ||
      mimeType === 'text/markdown'
    )
  }
  return false
}

let tesseractWorker: Worker | null = null
let tesseractWorkerPromise: Promise<Worker | null> | null = null

async function getTesseractWorker(): Promise<Worker | null> {
  if (tesseractWorker) return tesseractWorker
  if (tesseractWorkerPromise) return tesseractWorkerPromise

  tesseractWorkerPromise = (async () => {
    try {
      // eng + chi_sim covers most clinical reports we see
      tesseractWorker = await createWorker('eng+chi_sim')
      return tesseractWorker
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[document-extractor] Failed to create tesseract worker:', message)
      return null
    }
  })()

  return tesseractWorkerPromise
}

async function ocrPdfPages(
  parser: PDFParse,
  options: Required<Pick<ExtractOptions, 'maxChars' | 'ocrPageLimit' | 'ocrScale'>>,
): Promise<string> {
  const worker = await getTesseractWorker()
  if (!worker) return '[PDF has no text layer and OCR is unavailable]'

  let totalPages = 1
  try {
    const info = await parser.getInfo({ parsePageInfo: true })
    totalPages = info.pages?.length || 1
  } catch {
    // ignore
  }
  const pagesToOcr = Math.min(totalPages, options.ocrPageLimit)
  const pageNumbers = Array.from({ length: pagesToOcr }, (_, i) => i + 1)

  try {
    const screenshot = await parser.getScreenshot({
      scale: options.ocrScale,
      imageBuffer: true,
      partial: pageNumbers,
    })

    let ocrText = ''
    for (const page of screenshot.pages) {
      if (!page.data) continue
      const result = await worker.recognize(Buffer.from(page.data))
      if (result.data.text) {
        ocrText += result.data.text + '\n'
      }
      if (ocrText.length >= options.maxChars) break
    }

    return (ocrText.trim() || '[PDF OCR returned empty text]').slice(0, options.maxChars)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return `[PDF OCR failed: ${message}]`
  }
}

async function extractPdfText(
  buffer: Buffer,
  options: Required<Pick<ExtractOptions, 'maxChars' | 'ocrPageLimit' | 'ocrScale'>>,
): Promise<string> {
  let parser: PDFParse | undefined
  try {
    parser = new PDFParse({ data: new Uint8Array(buffer) })

    // #fix: 大文件分档解析 — 超过 PAGE_LIMITED_PARSE_BYTES 只解析前
    // MAX_TEXT_PAGES 页(partial 仅物化所选页,内存不再随总页数膨胀)。
    const fileBytes = buffer.byteLength
    let limitedPages: number[] | undefined
    if (fileBytes > PAGE_LIMITED_PARSE_BYTES) {
      const info = await parser.getInfo({ parsePageInfo: true })
      const totalPages = info.pages?.length || 1
      limitedPages = Array.from({ length: Math.min(totalPages, MAX_TEXT_PAGES) }, (_, i) => i + 1)
    }

    // Layer 1: try the electronic text layer
    // #fix: parseHyperlinks 把 PDF 内的超链接还原成 markdown 链接
    // ([text](url)),超链接引用(参考文献/DOI)不再变成一坨纯文字。
    const textResult = limitedPages
      ? await parser.getText({ partial: limitedPages, parseHyperlinks: true })
      : await parser.getText({ parseHyperlinks: true })
    let text = textResult.text.trim()
    if (text.length >= OCR_TEXT_THRESHOLD) {
      if (limitedPages) {
        text = `[注: 文件超过 ${Math.round(PAGE_LIMITED_PARSE_BYTES / 1024 / 1024)}MB，仅解析前 ${limitedPages.length} 页]\n${text}`
      }
      return text.slice(0, options.maxChars)
    }

    // Layer 2: OCR fallback for scanned/image PDFs
    const ocrText = await ocrPdfPages(parser, options)
    return ocrText
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return `[PDF extraction failed: ${message}]`
  } finally {
    await parser?.destroy().catch(() => {})
  }
}

// #fix: DOCX 结构化提取 — mammoth.convertToHtml 保留标题/粗体/列表/表格,
// 再经 turndown 转 markdown(与 web 端 doc-convert.ts 同款 GFM 表格规则),
// LLM 才能分清"哪是标题、哪是表格第几列",而不是一行行拍平的纯文字。
const docxTurndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**',
})

// #fix: mammoth 默认把 docx 内嵌图片转成 <img src="data:...;base64,...">
// data URI。若不处理,经 turndown 变成 markdown 里一坨 base64 字符串 —
// 模型既看不懂、又吃满提取字符预算,真图还没到模型。这里:
//   1. 从 HTML 抽出 data URI 图片(供多模态 part 注入);
//   2. 转 markdown 前把 <img> 换成 [图] 占位符,文本保持干净。
const DOCX_IMG_RE = /<img[^>]*>/gi
const DOCX_DATA_URI_RE = /<img[^>]*src="data:([^;,]+);base64,([^"]+)"[^>]*>/gi

function extractDocxDataUris(html: string): { mime: string; dataBase64: string }[] {
  const images: { mime: string; dataBase64: string }[] = []
  let m: RegExpExecArray | null
  while ((m = DOCX_DATA_URI_RE.exec(html)) !== null) {
    images.push({ mime: m[1], dataBase64: m[2] })
  }
  return images
}

function docxHtmlWithoutImages(html: string): string {
  return html.replace(DOCX_IMG_RE, '[图]')
}

// turndown 无内置表格支持 — 把 <table> 渲染成 GFM 表格。
// 注意:Node 环境下 turndown 用 domino 解析,其 NodeList 不可迭代,
// 必须用下标访问(for...of 会抛 "is not iterable")。
function docxTableToMarkdown(table: HTMLElement): string {
  const rows: string[][] = []
  const trs = table.querySelectorAll('tr')
  for (let r = 0; r < trs.length; r++) {
    const cells: string[] = []
    const td = trs[r].querySelectorAll('th,td')
    for (let c = 0; c < td.length; c++) {
      cells.push(td[c].textContent?.replace(/\s+/g, ' ').trim() ?? '')
    }
    if (cells.length > 0) rows.push(cells)
  }
  if (rows.length === 0) return ''
  const cols = Math.max(...rows.map((r) => r.length))
  const line = (cells: string[]) =>
    `| ${Array.from({ length: cols }, (_, i) => cells[i] ?? '').join(' | ')} |`
  const sep = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`
  return [line(rows[0]), sep, ...rows.slice(1).map(line)].join('\n')
}

docxTurndown.addRule('table', {
  filter: 'table',
  replacement: (_content: string, node: Node) => {
    const md = docxTableToMarkdown(node as HTMLElement)
    return md ? `\n\n${md}\n\n` : ''
  },
})

async function extractDocxText(buffer: Buffer, maxChars: number): Promise<string> {
  try {
    // #fix: 结构化优先 — 失败或空内容才回退 extractRawText(原行为)。
    // <img> 先替换为 [图] 占位,避免 base64 data URI 混进文本。
    const html = await mammoth.convertToHtml({ buffer })
    const md = docxTurndown.turndown(docxHtmlWithoutImages(html.value)).trim()
    if (md) return md.slice(0, maxChars)
    const fallback = await mammoth.extractRawText({ buffer })
    return fallback.value.trim().slice(0, maxChars) || '[DOCX returned empty text]'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return `[DOCX extraction failed: ${message}]`
  }
}

/**
 * #fix: 一次解析同时产出 DOCX 文本 + 内嵌图片(与 PDF 路径对齐)。
 * 图片从 mammoth 的 data URI 抽出,直接转多模态 part;文本侧由
 * extractDocxText 保证干净。非 DOCX/文件缺失 → null;超大文件跳过。
 */
export async function extractDocxContentFromUpload(
  userId: string,
  fileId: string,
  options: { maxChars: number; vision: boolean } = { maxChars: 30000, vision: false },
): Promise<{ text: string; images: ExtractedPdfImage[] } | null> {
  const filepath = safeUploadPath(userId, fileId)
  if (!filepath || !fs.existsSync(filepath)) return null
  const originalName = fileId.split('_').slice(1).join('_') || fileId

  const stat = fs.statSync(filepath)
  if (stat.size > MAX_EXTRACT_FILE_BYTES) {
    return {
      text: `[附件 ${originalName} 超过 ${Math.round(MAX_EXTRACT_FILE_BYTES / 1024 / 1024)}MB，已跳过文本提取以避免服务崩溃；请压缩后重新上传]`,
      images: [],
    }
  }

  const buffer = fs.readFileSync(filepath)
  // #fix: 嗅探优先 — 文件头是 zip(docx 容器)即按 docx 处理,扩展名只兜底。
  const sniffed = sniffDocumentMime(buffer)
  if (!isDocx(originalName) && sniffed !== 'application/zip') return null

  const text = await extractDocxText(buffer, options.maxChars)
  const images: ExtractedPdfImage[] = []
  if (options.vision && stat.size <= MAX_PDF_IMAGE_FILE_BYTES) {
    try {
      const html = await mammoth.convertToHtml({ buffer })
      for (const img of extractDocxDataUris(html.value)) {
        if (img.dataBase64.length > MAX_PDF_IMAGE_BYTES) continue
        images.push({ mime: img.mime || 'image/png', dataBase64: img.dataBase64, page: 1 })
        if (images.length >= MAX_PDF_IMAGES) break
      }
    } catch {
      // 图片提取失败不影响文本
    }
  }
  return { text, images }
}

export async function extractDocumentText(
  buffer: Buffer,
  filename: string,
  mimeType?: string,
  options: ExtractOptions = {},
): Promise<string> {
  const maxChars = options.maxChars ?? 30000
  const ocrPageLimit = options.ocrPageLimit ?? DEFAULT_OCR_PAGE_LIMIT
  const ocrScale = options.ocrScale ?? DEFAULT_OCR_SCALE

  // #fix(参考 opencode):magic bytes 嗅探优先于扩展名 — 把 PDF 改名 .txt
  // 或去掉扩展名后仍走正确的解析路径,而不是按文本解码出乱码。
  const sniffed = sniffDocumentMime(buffer)

  if (sniffed === 'application/pdf' || isPdf(filename, mimeType)) {
    return extractPdfText(buffer, { maxChars, ocrPageLimit, ocrScale })
  }

  // zip 容器可能是 docx/xlsx/pptx — 统一按 docx 尝试(mammoth 失败回退文本)。
  if (sniffed === 'application/zip' || isDocx(filename, mimeType)) {
    return extractDocxText(buffer, maxChars)
  }

  if (sniffed && sniffed.startsWith('image/')) {
    return `[附件 ${filename} 是图片(${sniffed}),不提取文本;如需分析图片内容请使用支持视觉的模型或 ocr_image 工具]`
  }

  if (isText(filename, mimeType)) {
    return buffer.toString('utf-8').slice(0, maxChars).trim()
  }

  // For everything else, attempt a UTF-8 decode as a best-effort fallback.
  try {
    return buffer.toString('utf-8').slice(0, maxChars).trim()
  } catch {
    return ''
  }
}

export async function extractTextFromUpload(
  userId: string,
  fileId: string,
  options?: ExtractOptions,
): Promise<string> {
  const filepath = safeUploadPath(userId, fileId)
  if (!filepath || !fs.existsSync(filepath)) return ''

  // #fix: 超大附件在 readFileSync 前拦截 — 避免 pdf.js/OCR 把进程内存打爆。
  const stat = fs.statSync(filepath)
  if (stat.size > MAX_EXTRACT_FILE_BYTES) {
    const name = fileId.split('_').slice(1).join('_') || fileId
    return `[附件 ${name} 超过 ${Math.round(MAX_EXTRACT_FILE_BYTES / 1024 / 1024)}MB，已跳过文本提取以避免服务崩溃；请压缩后重新上传]`
  }

  const buffer = fs.readFileSync(filepath)
  // fileId format from upload endpoint is usually `<uuid>_<originalName>`
  const originalName = fileId.split('_').slice(1).join('_') || fileId
  return extractDocumentText(buffer, originalName, undefined, options)
}

// ────────────────────────────────────────────────────────────────────────────
// #fix: PDF 纯文本 → markdown 结构恢复(导入文档用)。
// pdf-parse 的 getText 只给平铺文本行,标题/段落边界全部丢失。恢复层:
//   1. 章节标题(中英常见标题 + 编号标题)→ `## `(同一标题重复出现视为
//      页眉/页脚,跳过);
//   2. 按行尾标点重建段落 — 行尾无句子标点则与下一行合并(英文补空格,
//      中文直接拼接),OCR 文本同样适用。
// 表格无法从平铺文本可靠还原(单元格对齐信息已丢失),保持现状。
// ────────────────────────────────────────────────────────────────────────────

const PDF_SECTION_HEADINGS = new Set([
  // 英文期刊常见章节
  'abstract', 'introduction', 'background', 'materials and methods', 'methods', 'method',
  'results', 'discussion', 'conclusions', 'conclusion', 'references', 'bibliography',
  'acknowledgements', 'acknowledgments', 'limitations', 'keywords', 'key words',
  'summary', 'appendix', 'funding', 'conflicts of interest', 'supplementary materials',
  // 中文期刊常见章节
  '摘要', '引言', '前言', '背景', '材料与方法', '方法', '研究对象', '结果', '讨论',
  '结论', '参考文献', '致谢', '关键词', '局限性', '附录', '利益冲突', '统计学分析',
])

/** 常见章节标题(整行独立、长度 ≤40 才命中)。 */
function isPdfHeadingLine(line: string): boolean {
  const t = line.trim()
  if (!t || t.length > 40) return false
  if (PDF_SECTION_HEADINGS.has(t.toLowerCase())) return true
  // 编号标题 — 两种形态:
  //  a) "1. Introduction" / "1. 引言":数字 + 分隔符(点/顿号);
  //  b) "1.1 Background" / "3.2.1 分析":点分组数字(含点),分隔符可省。
  //  "10 patients were enrolled" 两种都不命中(无点分组、无分隔符)。
  if (/^\d+[.．、]\s*[A-Za-z\u4e00-\u9fa5]/.test(t)) return true
  if (/^\d+(\.\d+)+[.．、]?\s+[A-Za-z\u4e00-\u9fa5]/.test(t)) return true
  // 中文编号标题:一、引言 / 1) 方法
  if (/^[一二三四五六七八九十]+[、.．]\s*\S/.test(t)) return true
  return false
}

function endsSentence(s: string): boolean {
  return /[。！？；!?;…]$/.test(s.trim())
}

export function pdfTextToMarkdown(text: string): string {
  const lines = (text || '').split('\n')
  const out: string[] = []
  let para: string[] = []
  let lastHeading = ''

  const flushPara = () => {
    if (para.length > 0) {
      out.push(para.join(''))
      para = []
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const trimmed = line.trim()
    if (!trimmed) {
      flushPara()
      continue
    }
    if (isPdfHeadingLine(trimmed)) {
      flushPara()
      // 同一标题重复(页眉/页脚)只保留第一次。
      if (lastHeading === trimmed) continue
      lastHeading = trimmed
      out.push(`## ${trimmed}`)
      continue
    }
    if (para.length > 0 && !endsSentence(para[para.length - 1])) {
      // 段落续行:英文单词间补空格,中文直接拼接。
      const prev = para[para.length - 1]
      const needsSpace = /[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(trimmed)
      para[para.length - 1] = prev + (needsSpace ? ' ' : '') + trimmed
    } else {
      para.push(trimmed)
    }
  }
  flushPara()
  return out.join('\n\n')
}

/**
 * #fix: 导入文档专用提取 — 输出保留结构的 markdown:
 * - PDF/OCR 文本 → pdfTextToMarkdown(标题/段落恢复)
 * - DOCX → mammoth 结构化 markdown(标题/加粗/GFM 表格)
 * - txt/md → 原样
 */
export async function extractDocumentMarkdownFromUpload(
  userId: string,
  fileId: string,
  options: { maxChars?: number } = {},
): Promise<string> {
  const filepath = safeUploadPath(userId, fileId)
  if (!filepath || !fs.existsSync(filepath)) return ''
  const maxChars = options.maxChars ?? 300000

  const stat = fs.statSync(filepath)
  if (stat.size > MAX_EXTRACT_FILE_BYTES) {
    const name = fileId.split('_').slice(1).join('_') || fileId
    return `[附件 ${name} 超过 ${Math.round(MAX_EXTRACT_FILE_BYTES / 1024 / 1024)}MB，已跳过文本提取以避免服务崩溃；请压缩后重新上传]`
  }

  const buffer = fs.readFileSync(filepath)
  const originalName = fileId.split('_').slice(1).join('_') || fileId
  const sniffed = sniffDocumentMime(buffer)

  if (sniffed === 'application/pdf' || isPdf(originalName)) {
    const text = await extractPdfText(buffer, {
      maxChars,
      ocrPageLimit: DEFAULT_OCR_PAGE_LIMIT,
      ocrScale: DEFAULT_OCR_SCALE,
    })
    return pdfTextToMarkdown(text)
  }

  if (sniffed === 'application/zip' || isDocx(originalName)) {
    return extractDocxText(buffer, maxChars)
  }

  return buffer.toString('utf-8').slice(0, maxChars).trim()
}

export interface ExtractedMarkdownContent {
  text: string
  images: ExtractedPdfImage[]
}

/**
 * #fix: 导入文档专用提取(markdown + 内嵌图片)— PDF/DOCX 的图片同时抽出,
 * 供导入时落盘为可托管文件并在文档里渲染(取代 [图] 占位符)。
 * - PDF → pdfTextToMarkdown 结构恢复 + extractPdfContentFromUpload 内嵌图
 * - DOCX → mammoth markdown(含 [图] 占位)+ data URI 图
 * - txt/md → 原样,无图
 */
export async function extractDocumentMarkdownWithImagesFromUpload(
  userId: string,
  fileId: string,
  options: { maxChars?: number } = {},
): Promise<ExtractedMarkdownContent> {
  const filepath = safeUploadPath(userId, fileId)
  if (!filepath || !fs.existsSync(filepath)) return { text: '', images: [] }
  const maxChars = options.maxChars ?? 300000

  const stat = fs.statSync(filepath)
  if (stat.size > MAX_EXTRACT_FILE_BYTES) {
    const name = fileId.split('_').slice(1).join('_') || fileId
    return {
      text: `[附件 ${name} 超过 ${Math.round(MAX_EXTRACT_FILE_BYTES / 1024 / 1024)}MB，已跳过文本提取以避免服务崩溃；请压缩后重新上传]`,
      images: [],
    }
  }

  const buffer = fs.readFileSync(filepath)
  const originalName = fileId.split('_').slice(1).join('_') || fileId
  const sniffed = sniffDocumentMime(buffer)

  if (sniffed === 'application/pdf' || isPdf(originalName)) {
    const pdf = await extractPdfContentFromUpload(userId, fileId, { maxChars, vision: true })
    return { text: pdfTextToMarkdown(pdf?.text || ''), images: pdf?.images || [] }
  }

  if (sniffed === 'application/zip' || isDocx(originalName)) {
    const docx = await extractDocxContentFromUpload(userId, fileId, { maxChars, vision: true })
    return { text: docx?.text || '', images: docx?.images || [] }
  }

  return { text: buffer.toString('utf-8').slice(0, maxChars).trim(), images: [] }
}

// #fix: PDF 内嵌图片提取 — getImage 抽出原始位图(图表/照片/示意图),
// 视觉模型下作为多模态 part 随文本一起注入,AI 看到的不再是
// "图 3 显示…" 这类占位文字,而是图本身。上限为常量防止 token 超支:
// 只看前 MAX_PDF_IMAGE_PAGES 页、最多 MAX_PDF_IMAGES 张、过滤小图标、
// 单张 base64 不超过 MAX_PDF_IMAGE_BYTES。
// #relax: 2026-08 导入即草稿后,图主要供文档渲染而非每轮注入模型,
// 限额放宽(6→20 页、8→24 张、1.5MB→4MB、25MB→50MB)以提升草稿保真度。
const MAX_PDF_IMAGE_PAGES = 20
const MAX_PDF_IMAGES = 24
const MIN_PDF_IMAGE_PIXELS = 100 * 100
const MAX_PDF_IMAGE_BYTES = 4 * 1024 * 1024
// #fix: 超过此体积的 PDF 跳过内嵌图片提取 — getImage 会把整页图片同时
// 物化成 RGBA,大 PDF(几十 MB)在解析文本之外再来一遍会撑爆进程内存
// (OOM kill → SSE 连接重置 → 前端 "network error")。大文件通常是文字
// 为主的稿件,图对 LLM 的意义有限,直接省掉。
const MAX_PDF_IMAGE_FILE_BYTES = 50 * 1024 * 1024

export interface ExtractedPdfImage {
  mime: string
  dataBase64: string
  page: number
}

export interface ExtractedPdfContent {
  text: string
  images: ExtractedPdfImage[]
}

function mimeFromImageName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  }
  return map[ext] || 'image/png'
}

/**
 * #fix: 单次解析同时产出 PDF 文本 + 内嵌图片 — 共享一个 PDFParse 实例,
 * 不再先 parse 一次文本、再 parse 一次 getImage(每遍都会 readFileSync +
 * pdf.js 全量载入,大 PDF 内存峰值翻倍,直接触发 OOM)。
 * 非 PDF/文件缺失 → null;超大文件 → 文本跳过 + 无图。
 */
export async function extractPdfContentFromUpload(
  userId: string,
  fileId: string,
  options: { maxChars: number; vision: boolean } = { maxChars: 30000, vision: false },
): Promise<ExtractedPdfContent | null> {
  const filepath = safeUploadPath(userId, fileId)
  if (!filepath || !fs.existsSync(filepath)) return null
  const originalName = fileId.split('_').slice(1).join('_') || fileId

  const stat = fs.statSync(filepath)
  if (stat.size > MAX_EXTRACT_FILE_BYTES) {
    return {
      text: `[附件 ${originalName} 超过 ${Math.round(MAX_EXTRACT_FILE_BYTES / 1024 / 1024)}MB，已跳过文本提取以避免服务崩溃；请压缩后重新上传]`,
      images: [],
    }
  }

  const buffer = fs.readFileSync(filepath)
  // #fix: 嗅探优先 — 文件头 %PDF 即按 PDF 处理,扩展名只兜底。
  const sniffed = sniffDocumentMime(buffer)
  if (!isPdf(originalName) && sniffed !== 'application/pdf') return null

  const fileBytes = buffer.byteLength
  let parser: PDFParse | undefined
  try {
    parser = new PDFParse({ data: new Uint8Array(buffer) })

    // ── 文本层(大文件分档:超过 PAGE_LIMITED_PARSE_BYTES 只解析前 N 页)──
    let limitedPages: number[] | undefined
    if (fileBytes > PAGE_LIMITED_PARSE_BYTES) {
      const info = await parser.getInfo({ parsePageInfo: true })
      const totalPages = info.pages?.length || 1
      limitedPages = Array.from({ length: Math.min(totalPages, MAX_TEXT_PAGES) }, (_, i) => i + 1)
    }
    const textResult = limitedPages
      ? await parser.getText({ partial: limitedPages, parseHyperlinks: true })
      : await parser.getText({ parseHyperlinks: true })
    let text = textResult.text.trim()
    if (text.length >= OCR_TEXT_THRESHOLD) {
      if (limitedPages) {
        text = `[注: 文件超过 ${Math.round(PAGE_LIMITED_PARSE_BYTES / 1024 / 1024)}MB，仅解析前 ${limitedPages.length} 页]\n${text}`
      }
    } else {
      // 扫描版 PDF — OCR 兜底(已按页限量)。
      text = await ocrPdfPages(parser, {
        maxChars: options.maxChars,
        ocrPageLimit: DEFAULT_OCR_PAGE_LIMIT,
        ocrScale: DEFAULT_OCR_SCALE,
      })
    }
    text = text.slice(0, options.maxChars)

    // ── 内嵌图片(复用同一 parser;仅视觉模型 + 体积上限内才提取)──
    const images: ExtractedPdfImage[] = []
    if (options.vision && fileBytes <= MAX_PDF_IMAGE_FILE_BYTES) {
      const result = await parser.getImage({
        first: MAX_PDF_IMAGE_PAGES,
        imageThreshold: 100,
        imageBuffer: true,
        imageDataUrl: false,
      })
      for (const page of result.pages) {
        for (const img of page.images) {
          if (img.width * img.height < MIN_PDF_IMAGE_PIXELS) continue
          const base64 = Buffer.from(img.data).toString('base64')
          if (base64.length > MAX_PDF_IMAGE_BYTES) continue
          images.push({ mime: mimeFromImageName(img.name), dataBase64: base64, page: page.pageNumber })
          if (images.length >= MAX_PDF_IMAGES) break
        }
        // 逐页释放 RGBA 缓冲 — 避免所有页的图片同时驻留内存。
        page.images.length = 0
        if (images.length >= MAX_PDF_IMAGES) break
      }
    }

    return { text, images }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { text: `[PDF extraction failed: ${message}]`, images: [] }
  } finally {
    await parser?.destroy().catch(() => {})
  }
}

/** 提取上传 PDF 内嵌图片。非 PDF/文件缺失/超大 → null;无可用图片 → []。 */
export async function extractPdfImagesFromUpload(
  userId: string,
  fileId: string,
): Promise<ExtractedPdfImage[] | null> {
  const content = await extractPdfContentFromUpload(userId, fileId, { maxChars: 30000, vision: true })
  return content ? content.images : null
}

/**
 * #511: read an uploaded image as a base64 data payload for multimodal
 * parts. Returns null when the file is missing or not a bitmap image.
 */
/** #511-followup: 多模态图片大小上限 — 超出降级为 OCR/文本说明,
 *  避免超大 base64 撑爆 LLM 请求体与上下文预算。 */
const MAX_IMAGE_UPLOAD_BYTES = 4 * 1024 * 1024

// #fix(参考 opencode image.normalize):大图用 sharp 归一化 — 论文里的
// 高清图/病理截图常超 4MB,此前直接降级成"请压缩后上传",模型看不到。
// 现在缩放长边 ≤2048 + webp q80,压缩到预算内再注入(质量对图表足够)。
const NORMALIZE_LONG_EDGE = 2048
const NORMALIZE_QUALITY = 80
const MAX_NORMALIZE_FILE_BYTES = 32 * 1024 * 1024

const mimeByExt: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
}

/** sharp 归一化:长边缩到 NORMALIZE_LONG_EDGE(不放大)、webp 输出。
 *  成功返回压缩后的数据;失败返回 null(调用方走 oversized 降级)。 */
async function normalizeImageBuffer(buffer: Buffer): Promise<{ mime: string; dataBase64: string } | null> {
  try {
    const out = await sharp(buffer)
      .resize({ width: NORMALIZE_LONG_EDGE, height: NORMALIZE_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: NORMALIZE_QUALITY })
      .toBuffer()
    return { mime: 'image/webp', dataBase64: out.toString('base64') }
  } catch (err) {
    console.warn('[document-extractor] Image normalization failed:', (err as Error).message.slice(0, 80))
    return null
  }
}

/**
 * #511: 读取上传图片为 base64 多模态数据。
 * - 非图片/文件缺失 → null(调用方走文本路径)
 * - 图片但超过 MAX_IMAGE_UPLOAD_BYTES → 尝试 sharp 归一化压缩后返回
 *   ({ normalized: true });压缩失败 → { oversized: true }(调用方降级)
 * - 正常 → { mime, dataBase64 }
 * #fix: 类型判定用 magic bytes 嗅探优先(无扩展名/伪装扩展名的图片也能识别)。
 */
export async function extractImageUpload(
  userId: string,
  fileId: string,
): Promise<{ mime: string; dataBase64: string; normalized?: boolean } | { oversized: true } | null> {
  const filepath = safeUploadPath(userId, fileId)
  if (!filepath || !fs.existsSync(filepath)) return null

  const originalName = fileId.split('_').slice(1).join('_') || fileId
  const stat = fs.statSync(filepath)
  if (stat.size > MAX_NORMALIZE_FILE_BYTES) {
    // 超大到连归一化都不做(读进内存不划算)—— 按扩展名兜底判定。
    return isImageFile(originalName) ? { oversized: true } : null
  }

  const buffer = fs.readFileSync(filepath)
  const sniffed = sniffDocumentMime(buffer)
  if (!sniffed || !sniffed.startsWith('image/')) {
    if (!isImageFile(originalName)) return null
  }

  const mime = sniffed && sniffed.startsWith('image/') ? sniffed : (mimeByExt[originalName.split('.').pop()?.toLowerCase() || ''] || 'image/png')
  if (buffer.length <= MAX_IMAGE_UPLOAD_BYTES) {
    return { mime, dataBase64: buffer.toString('base64') }
  }

  // 超过 4MB — 先尝试归一化,再考虑降级。
  const normalized = await normalizeImageBuffer(buffer)
  if (normalized) return { ...normalized, normalized: true }
  return { oversized: true }
}
