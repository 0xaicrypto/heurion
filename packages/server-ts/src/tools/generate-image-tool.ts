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

// #419: DB-configured settings win over env.
async function imgConfig(userId: string): Promise<{ baseUrl: string; key: string | null; model: string }> {
  let db: { base_url?: string; model?: string; img_api_key?: string } = {}
  try {
    const prisma = (await import('../common/prisma.js')).default
    const rows = await (prisma as any).setting.findMany({ where: { userId } })
    for (const r of rows) (db as Record<string, string>)[r.key] = r.value
  } catch { /* no db */ }
  return {
    baseUrl: (db.base_url || process.env.IMG_API_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    key: db.img_api_key || process.env.IMG_API_KEY || null,
    model: db.model || process.env.IMG_MODEL || 'dall-e-3',
  }
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
    const userId = this.ctx?.userId || 'unknown'
    const cfg = await imgConfig(userId)
    if (!cfg.key) {
      return { success: false, error: 'generate_image is not configured — set it in Settings → LLM → 图像生成 (or IMG_API_KEY env). Describe the image in text instead.' }
    }

    try {
      // #419: retry once on 429/5xx (transient rate limits).
      let res: Response | null = null
      let lastStatus = 0
      for (let attempt = 0; attempt < 2 && !res; attempt++) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 60000)
        const r = await fetch(`${cfg.baseUrl}/images/generations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
          body: JSON.stringify({ model: cfg.model, prompt, n: 1, size, response_format: 'b64_json' }),
          signal: controller.signal,
        })
        clearTimeout(timer)
        lastStatus = r.status
        if (r.ok || (r.status !== 429 && r.status < 500)) { res = r; break }
        if (attempt === 0) await new Promise((r2) => setTimeout(r2, 1500))
      }
      if (!res) throw new Error(`Image API retries exhausted (last HTTP ${lastStatus})`)
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Image API HTTP ${res.status}: ${text.slice(0, 150)}`)
      }
      const data: any = await res.json()
      const b64 = data?.data?.[0]?.b64_json || data?.data?.[0]?.url
      if (!b64) return { success: false, error: 'Image API returned no image data' }

      // Save to the user's attachments dir (same layout as render_chart).
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
