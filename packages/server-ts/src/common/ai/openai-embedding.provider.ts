import type { AiProvider, AiProviderConfig, EmbedOptions } from './ai-provider.js'
import { AiProviderError } from './ai-provider.js'

export class OpenAIEmbeddingProvider implements Pick<AiProvider, 'embed'> {
  constructor(private config: AiProviderConfig = {}) {}

  async embed(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
    if (!texts.length) return []

    const apiKey = this.config.openaiApiKey || process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new AiProviderError('OPENAI_API_KEY is not configured', 'config_missing')
    }

    const model = options.model || this.config.openaiEmbeddingModel || 'text-embedding-3-small'

    const resp = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ input: texts, model, dimensions: options.dimensions }),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new AiProviderError(
        `OpenAI Embedding API error ${resp.status}: ${text.slice(0, 200)}`,
        'api_error',
        resp.status,
      )
    }

    const data: any = await resp.json()
    if (!Array.isArray(data?.data) || data.data.length !== texts.length) {
      throw new AiProviderError('Invalid OpenAI embedding response shape', 'invalid_response')
    }

    return data.data.map((item: any) => item.embedding as number[])
  }
}
