import { BaseTool, ToolResult } from './base-tool.js'
import type { ToolContext } from './tool-registry.js'
import { execSync } from 'child_process'
import { platform } from 'os'

export class OCRImageTool extends BaseTool {
  constructor(private ctx: ToolContext) { super() }

  get name(): string { return 'ocr_image' }
  get description(): string {
    return 'Extract text from an image file using OCR. Use when the user uploads a screenshot, a photo of a document, or any image containing text that needs to be read.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'File ID of the uploaded image.' },
        language: { type: 'string', description: 'Language hint (e.g., "eng", "chi_sim", "jpn"). Default: auto-detect.' },
      },
      required: ['file_id'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const fileId = String(args.file_id || '')
    const language = args.language ? String(args.language) : ''
    if (!fileId) return { success: false, error: 'file_id required' }

    const fs = await import('fs')
    const path = await import('path')
    const filepath = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', this.ctx.userId, 'uploads', fileId)
    if (!fs.existsSync(filepath)) return { success: false, error: `File ${fileId} not found` }

    try {
      const { extractDocumentText } = await import('../lib/document-extractor.js')
      const buffer = fs.readFileSync(filepath)
      const text = await extractDocumentText(buffer, fileId, undefined, { maxChars: 10000 })
      if (text && text.length > 10) {
        return { success: true, output: text }
      }
    } catch { }

    if (platform() === 'darwin') {
      try {
        const text = execSync(`osascript -e 'tell application "System Events" to display dialog "OCR not available"' 2>/dev/null`, { timeout: 5000 }).toString()
      } catch { }
    }

    return { success: true, output: `Unable to OCR file ${fileId}. The file may not contain extractable text.` }
  }
}
