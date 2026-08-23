import fs from 'fs'
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { PDFParse } from 'pdf-parse'
import { createWorker, type Worker } from 'tesseract.js'
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

function isDocx(filename: string, mimeType?: string): boolean {
  const lower = filename.toLowerCase()
  return lower.endsWith('.docx') || mimeType === DOCX_MIME_TYPE
}

function isPdf(filename: string, mimeType?: string): boolean {
  const lower = filename.toLowerCase()
  return lower.endsWith('.pdf') || mimeType === 'application/pdf'
}

export { isPdf }

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
    const html = await mammoth.convertToHtml({ buffer })
    const md = docxTurndown.turndown(html.value).trim()
    if (md) return md.slice(0, maxChars)
    const fallback = await mammoth.extractRawText({ buffer })
    return fallback.value.trim().slice(0, maxChars) || '[DOCX returned empty text]'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return `[DOCX extraction failed: ${message}]`
  }
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

  if (isPdf(filename, mimeType)) {
    return extractPdfText(buffer, { maxChars, ocrPageLimit, ocrScale })
  }

  if (isDocx(filename, mimeType)) {
    return extractDocxText(buffer, maxChars)
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

// #fix: PDF 内嵌图片提取 — getImage 抽出原始位图(图表/照片/示意图),
// 视觉模型下作为多模态 part 随文本一起注入,AI 看到的不再是
// "图 3 显示…" 这类占位文字,而是图本身。上限为常量防止 token 超支:
// 只看前 MAX_PDF_IMAGE_PAGES 页、最多 MAX_PDF_IMAGES 张、过滤小图标、
// 单张 base64 不超过 MAX_PDF_IMAGE_BYTES。
const MAX_PDF_IMAGE_PAGES = 6
const MAX_PDF_IMAGES = 8
const MIN_PDF_IMAGE_PIXELS = 100 * 100
const MAX_PDF_IMAGE_BYTES = 1.5 * 1024 * 1024

export interface ExtractedPdfImage {
  mime: string
  dataBase64: string
  page: number
}

function mimeFromImageName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  }
  return map[ext] || 'image/png'
}

/** 提取上传 PDF 内嵌图片。非 PDF/文件缺失/超大 → null;无可用图片 → []。 */
export async function extractPdfImagesFromUpload(
  userId: string,
  fileId: string,
): Promise<ExtractedPdfImage[] | null> {
  const filepath = safeUploadPath(userId, fileId)
  if (!filepath || !fs.existsSync(filepath)) return null
  const originalName = fileId.split('_').slice(1).join('_') || fileId
  if (!isPdf(originalName)) return null
  const stat = fs.statSync(filepath)
  if (stat.size > MAX_EXTRACT_FILE_BYTES) return null

  const buffer = fs.readFileSync(filepath)
  let parser: PDFParse | undefined
  try {
    parser = new PDFParse({ data: new Uint8Array(buffer) })
    const result = await parser.getImage({
      first: MAX_PDF_IMAGE_PAGES,
      imageThreshold: 100,
      imageBuffer: true,
      imageDataUrl: false,
    })
    const out: ExtractedPdfImage[] = []
    for (const page of result.pages) {
      for (const img of page.images) {
        if (img.width * img.height < MIN_PDF_IMAGE_PIXELS) continue
        const base64 = Buffer.from(img.data).toString('base64')
        if (base64.length > MAX_PDF_IMAGE_BYTES) continue
        out.push({ mime: mimeFromImageName(img.name), dataBase64: base64, page: page.pageNumber })
        if (out.length >= MAX_PDF_IMAGES) return out
      }
    }
    return out
  } catch {
    return null
  } finally {
    await parser?.destroy().catch(() => {})
  }
}

/**
 * #511: read an uploaded image as a base64 data payload for multimodal
 * parts. Returns null when the file is missing or not a bitmap image.
 */
/** #511-followup: 多模态图片大小上限 — 超出降级为 OCR/文本说明,
 *  避免超大 base64 撑爆 LLM 请求体与上下文预算。 */
const MAX_IMAGE_UPLOAD_BYTES = 4 * 1024 * 1024

/**
 * #511: 读取上传图片为 base64 多模态数据。
 * - 非图片/文件缺失 → null(调用方走文本路径)
 * - 图片但超过 MAX_IMAGE_UPLOAD_BYTES → { oversized: true }(调用方降级)
 * - 正常 → { mime, dataBase64 }
 */
export async function extractImageUpload(
  userId: string,
  fileId: string,
): Promise<{ mime: string; dataBase64: string } | { oversized: true } | null> {
  const filepath = safeUploadPath(userId, fileId)
  if (!filepath || !fs.existsSync(filepath)) return null

  const originalName = fileId.split('_').slice(1).join('_') || fileId
  if (!isImageFile(originalName)) return null

  const stat = fs.statSync(filepath)
  if (stat.size > MAX_IMAGE_UPLOAD_BYTES) return { oversized: true }

  const mimeByExt: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  }
  const ext = originalName.split('.').pop()?.toLowerCase() || ''
  const mime = mimeByExt[ext] || 'image/png'
  const buffer = fs.readFileSync(filepath)
  return { mime, dataBase64: buffer.toString('base64') }
}
