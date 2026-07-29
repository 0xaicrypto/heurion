import type { AiProvider, AiProviderConfig, VisionImageInput, VisionOptions, VisionResult } from './ai-provider.js'
import { AiProviderError } from './ai-provider.js'

export class GeminiVisionProvider implements Pick<AiProvider, 'vision'> {
  constructor(private config: AiProviderConfig = {}) {}

  async vision(images: VisionImageInput[], prompt: string, options: VisionOptions = {}): Promise<VisionResult> {
    if (!images.length) {
      throw new AiProviderError('At least one image is required for vision analysis', 'invalid_response')
    }

    const apiKey = this.config.geminiApiKey || process.env.GEMINI_API_KEY
    if (!apiKey) {
      throw new AiProviderError('GEMINI_API_KEY is not configured', 'config_missing')
    }

    const model = options.model || this.config.geminiVisionModel || 'gemini-2.0-flash'
    const image = images[0]

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inlineData: { mimeType: image.mimeType || options.mimeType || 'image/png', data: image.base64 } },
            ],
          }],
        }),
      },
    )

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new AiProviderError(
        `Gemini Vision API error ${resp.status}: ${text.slice(0, 200)}`,
        'api_error',
        resp.status,
      )
    }

    const data: any = await resp.json()
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    return { content, model }
  }
}
