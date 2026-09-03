/**
 * #827: generate_image — 通过当前主模型直接生成图像(取代 #177 的独立
 * OpenAI images/generations 配置)。主模型多模态 → 直接用;非多模态或
 * 上游未返回图片 → 明确报错(工具层把 IMAGE_UNSUPPORTED 映射为用户可读
 * 的降级提示,agent 会转述并以文字描述代替)— 绝不静默失败。
 */
import { BaseTool, ToolResult } from './base-tool.js'
import type { ToolContext } from './tool-registry.js'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { getLlmGateway } from '../common/llm-gateway.js'

export class GenerateImageTool extends BaseTool {
  constructor(private ctx?: ToolContext) { super() }

  get name(): string { return 'generate_image' }
  get description(): string {
    return 'Generate an illustration / schematic image (e.g. study design diagram, beam-scan sketch) using the current multimodal main model. Returns a file_id + URL you can reference or embed. If the main model is not multimodal (image generation unsupported), the call fails with an explicit error — tell the user and describe the image in text instead.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed image prompt (style, content, layout)' },
      },
      required: ['prompt'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const prompt = String(args.prompt || '').trim()
    if (!prompt) return { success: false, error: 'prompt required' }
    const userId = this.ctx?.userId || 'unknown'

    try {
      const { mime, dataBase64 } = await getLlmGateway().generateImage(prompt, {
        telemetryContext: { userId, workspaceId: userId, action: 'tool.generate_image' },
      })

      // Save to the user's attachments dir (same layout as render_chart).
      const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
      fs.mkdirSync(dir, { recursive: true })
      const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png'
      const fileId = `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`
      fs.writeFileSync(path.join(dir, fileId), Buffer.from(dataBase64, 'base64'))

      // Canonical tokenized URL — same shape as render_chart (#213): <img>
      // cannot send Bearer headers, so a short-lived chart token is required.
      let url = `/api/v1/files/download/${fileId}`
      try {
        const { issueChartToken } = await import('../common/chart-token.js')
        url = `${url}?token=${issueChartToken(fileId, userId)}`
      } catch {
        // token issuance unavailable — URL still works for Bearer consumers
      }

      return {
        success: true,
        output: JSON.stringify({ file_id: fileId, url, prompt }, null, 2),
      }
    } catch (err) {
      const msg = (err as Error).message || 'generate_image failed'
      // IMAGE_UNSUPPORTED → 面向用户的明确降级提示(agent 转述 + 文字描述代替)
      if (msg.includes('IMAGE_UNSUPPORTED')) {
        return { success: false, error: msg.replace(/^IMAGE_UNSUPPORTED:\s*/, '无法生成图片 — ') }
      }
      return { success: false, error: `generate_image failed: ${msg.slice(0, 200)}` }
    }
  }
}
