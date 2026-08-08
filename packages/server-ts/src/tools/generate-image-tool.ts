/**
 * #177: generate_image — external text-to-image (OpenAI-compatible
 * images/generations endpoint). The generated image is saved to the user's
 * attachments and returned as a file_id + URL. Missing config and API
 * failures degrade to tool errors (the agent can fall back to a placeholder
 * description) — never crash the tool loop.
 */
import { BaseTool, ToolResult } from './base-tool.js'
import type { ToolContext } from './tool-registry.js'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const IMG_BASE = (process.env.IMG_API_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')

function imgApiKey(): string | null {
  return process.env.IMG_API_KEY || null
}

export class GenerateImageTool extends BaseTool {
  constructor(private ctx?: ToolContext) { super() }

  get name(): string { return 'generate_image' }
  get description(): string {
    return 'Generate an illustration / schematic image (e.g. study design diagram, beam-scan sketch) via the configured image API. Returns a file_id + URL you can reference or embed. If the API is unconfigured or fails, say so and describe the image in text instead.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed image prompt (style, content, layout)' },
        size: { type: 'string', enum: ['1024x1024', '1024x1792', '1792x1024'], default: '1024x1024' },
      },
      required: ['prompt'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const prompt = String(args.prompt || '').trim()
    if (!prompt) return { success: false, error: 'prompt required' }
    const size = String(args.size || '1024x1024')
    const key = imgApiKey()
    if (!key) {
      return { success: false, error: 'generate_image is not configured — set IMG_API_KEY (and optionally IMG_API_BASE_URL / IMG_MODEL). Describe the image in text instead.' }
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 60000)
      const res = await fetch(`${IMG_BASE}/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: process.env.IMG_MODEL || 'dall-e-3',
          prompt,
          n: 1,
          size,
          response_format: 'b64_json',
        }),
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Image API HTTP ${res.status}: ${text.slice(0, 150)}`)
      }
      const data: any = await res.json()
      const b64 = data?.data?.[0]?.b64_json || data?.data?.[0]?.url
      if (!b64) return { success: false, error: 'Image API returned no image data' }

      // Save to the user's attachments dir (same layout as render_chart).
      const userId = this.ctx?.userId || 'unknown'
      const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
      fs.mkdirSync(dir, { recursive: true })
      const fileId = `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.png`
      const filepath = path.join(dir, fileId)
      if (b64.startsWith('data:')) {
        fs.writeFileSync(filepath, Buffer.from(b64.split(',')[1] || '', 'base64'))
      } else if (b64.startsWith('http')) {
        const img = await fetch(b64, { signal: AbortSignal.timeout(30000) })
        fs.writeFileSync(filepath, Buffer.from(await img.arrayBuffer()))
      } else {
        fs.writeFileSync(filepath, Buffer.from(b64, 'base64'))
      }

      return {
        success: true,
        output: JSON.stringify({ file_id: fileId, url: `/api/v1/files/${fileId}/download`, prompt }, null, 2),
      }
    } catch (err) {
      return { success: false, error: `generate_image failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}
