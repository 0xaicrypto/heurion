import fs from 'fs'
import path from 'path'
import { PDFParse } from 'pdf-parse'
import { createWorker, type Worker } from 'tesseract.js'

export interface ExtractOptions {
  maxChars?: number
  ocrPageLimit?: number
  ocrScale?: number
}

const OCR_TEXT_THRESHOLD = 100
const DEFAULT_OCR_PAGE_LIMIT = 5
const DEFAULT_OCR_SCALE = 2

function isPdf(filename: string, mimeType?: string): boolean {
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

    // Layer 1: try the electronic text layer
    const textResult = await parser.getText()
    const text = textResult.text.trim()
    if (text.length >= OCR_TEXT_THRESHOLD) {
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
  const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
  const filepath = path.join(dir, fileId)
  if (!fs.existsSync(filepath)) return ''

  const buffer = fs.readFileSync(filepath)
  // fileId format from upload endpoint is usually `<uuid>_<originalName>`
  const originalName = fileId.split('_').slice(1).join('_') || fileId
  return extractDocumentText(buffer, originalName, undefined, options)
}
