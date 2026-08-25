import { BaseTool, ToolResult } from './base-tool.js'
import type { ToolContext } from './tool-registry.js'
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
    if (!fileId) return { success: false, error: 'file_id required' }

    const fs = await import('fs')
    const { safeUploadPath, uploadsBaseDir } = await import('../lib/upload-path.js')
    const filepath = safeUploadPath(this.ctx.userId, fileId)
    if (!filepath || !fs.existsSync(filepath)) {
      // #fix: 报错必须带可用 file_id 清单 — 模型在会话上下文里只看到
      // 参考材料 label(文件名),拿不到上传 file_id,直接拿文件名来调会
      // 必挂;同时明确 ocr_image 只服务图片,PDF/DOCX 走 import_reference。
      let candidates = ''
      try {
        const dir = uploadsBaseDir(this.ctx.userId)
        const names = fs.existsSync(dir)
          ? fs.readdirSync(dir).filter((f) => !f.startsWith('img_')).slice(0, 10)
          : []
        candidates = names.length > 0 ? `当前上传目录可用的 file_id: ${names.join(', ')}` : '当前用户没有可用的上传文件'
      } catch {
        candidates = '无法读取上传目录'
      }
      return {
        success: false,
        error: `File ${fileId} not found. ${candidates}. 注意:ocr_image 只用于图片文件(png/jpg/webp);PDF/DOCX 不是图片,读取其正文请改用 edit_document 的 import_reference 导入参考材料。`,
      }
    }

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
      } catch { }
    }

    return { success: true, output: `Unable to OCR file ${fileId}. The file may not contain extractable text.` }
  }
}
