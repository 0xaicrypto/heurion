import prisma from '../../../common/prisma.js'

export interface GeminiVisionInput {
  prompt: string
  base64Image: string
  mimeType?: string
  userId?: string
  model?: string
}

export async function getGeminiApiKey(userId?: string): Promise<string> {
  const envKey = process.env.GEMINI_API_KEY || ''
  if (envKey && envKey.length >= 10) return envKey

  if (userId) {
    try {
      const setting = await (prisma as any).userSetting.findUnique({
        where: { userId_key: { userId, key: 'gemini_api_key' } },
      })
      const value = setting?.value || ''
      if (value && value.length >= 10) return value
    } catch {
      // ignore setting lookup failures
    }
  }

  return ''
}

/**
 * Analyze an image with Google Gemini Vision.
 * Throws if no API key is configured or the API returns an error.
 */
export async function geminiVisionAnalyze(input: GeminiVisionInput): Promise<string> {
  const apiKey = await getGeminiApiKey(input.userId)
  if (!apiKey || apiKey.length < 10) {
    throw new Error('Gemini API key not configured')
  }

  const model = input.model || process.env.GEMINI_VISION_MODEL || 'gemini-2.0-flash'
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: input.prompt },
            { inlineData: { mimeType: input.mimeType || 'image/png', data: input.base64Image } },
          ],
        }],
      }),
    },
  )

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Gemini Vision ${resp.status}: ${text.slice(0, 200)}`)
  }

  const data: any = await resp.json()
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
}
