import fs from 'fs'
import path from 'path'
import { PDFParse } from 'pdf-parse'

export interface ExtractOptions {
  maxChars?: number
}

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

export async function extractDocumentText(
  buffer: Buffer,
  filename: string,
  mimeType?: string,
  options: ExtractOptions = {},
): Promise<string> {
  const { maxChars = 30000 } = options

  if (isPdf(filename, mimeType)) {
    let parser: PDFParse | undefined
    try {
      parser = new PDFParse({ data: new Uint8Array(buffer) })
      const result = await parser.getText()
      return result.text.trim().slice(0, maxChars)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return `[PDF extraction failed: ${message}]`
    } finally {
      await parser?.destroy().catch(() => {})
    }
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
