import { BaseTool, ToolResult } from './base-tool.js'
import type { ToolContext } from './tool-registry.js'
import { describeImage, visionModelForActiveProvider } from '../lib/image-vision.js'
import { fileIdFromUrl } from './fix-document-images-tool.js'

/**
 * #fix 2026-09 — view_image:文档内嵌图/截图的按需视觉理解(方案 A)。
 *
 * 模型对文档里的图片原本"盲"——正文是 markdown 文本,图片只是
 * `![caption](url)` 一行;模型知道图题与 URL,看不到像素。本工具把
 * 文件库图片(safeUploadPath 磁盘口径,与下载端点/fix_document_images
 * 一致)喂给当前多模态主模型,返回文字分析(不改 tool-loop 消息协议,
 * 工具结果仍是文本)。
 *
 * 与 ocr_image 的分工:ocr_image 走上传文件做文字提取(OCR);本工具
 * 服务"理解图片内容"(图表数据/流程图结构/截图画面),支持针对性提问。
 * 失败诚实报错,绝不编造图内容。
 */
export class ViewImageTool extends BaseTool {
  constructor(private ctx: ToolContext) { super() }

  get name(): string { return 'view_image' }

  get description(): string {
    return [
      'View an image (document figure, chart, screenshot) with vision and understand its content.',
      'Pass `image` as a file_id (from an image URL like /api/v1/files/download/<id>) or the full URL, optionally a `question` (e.g. "纵轴的单位是什么" / "总结图中的关键数据").',
      'Use when the user asks what an image shows, asks to verify/extract data from a figure, or before editing a caption that must match the picture.',
      'Returns a textual description/answer — never invent image content; if the image cannot be read the tool says so.',
    ].join(' ')
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Image file_id or full URL (e.g. the /api/v1/files/download/... URL from the document).' },
        question: { type: 'string', description: 'Optional specific question about the image. Omit for a general description.' },
      },
      required: ['image'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const raw = String(args.image || '').trim()
    if (!raw) return { success: false, error: 'image 参数必填(file_id 或完整 URL)。' }

    // URL / file_id 双形态解析 — URL 取 fileId(防路径穿越已由 safeUploadPath 兜底)。
    let fileId = raw
    if (raw.includes('/api/v1/files/') || raw.startsWith('http')) {
      const hit = fileIdFromUrl(raw)
      if (!hit) return { success: false, error: 'URL 不是本库文件下载链接(/api/v1/files/download/<id>) — 外部 URL 无法读取,请传文档图片行里的本库 URL 或 file_id。' }
      fileId = hit.fileId
    }

    if (!visionModelForActiveProvider()) {
      return {
        success: false,
        error: '当前主模型不支持图像理解 — 请在设置页切换到多模态模型(如 glm-5.3-flash),或改用 ocr_image 做文字提取(仅上传文件)。',
      }
    }

    const question = typeof args.question === 'string' && args.question.trim() ? args.question.trim() : undefined
    const answer = await describeImage(this.ctx.userId, fileId, question)
    if (!answer) {
      return {
        success: false,
        error: `无法读取图片 ${fileId}(文件不存在、不是图片格式、或视觉调用失败)。请确认 file_id 来自文档图片行(/api/v1/files/download/<id>),不要编造 id。`,
      }
    }
    return {
      success: true,
      output: question ? `图片理解(${fileId}):\n${answer}` : `图片内容(${fileId}):\n${answer}`,
    }
  }
}
