import type { AiProvider, AiProviderConfig, EmbedOptions } from './ai-provider.js'
import { AiProviderError } from './ai-provider.js'

/**
 * Local embedding adapter.
 *
 * Expects a local embedding HTTP service compatible with the following contract:
 *   POST { url }
 *   Body: { "texts": string[], "model": string }
 *   Response: { "embeddings": number[][] }
 *
 * Suitable backends: text-embeddings-inference (TEI), infinity, Ollama, or a
 * small FastAPI wrapper around sentence-transformers.
 */
export class LocalEmbeddingProvider implements Pick<AiProvider, 'embed'> {
  constructor(private config: AiProviderConfig = {}) {}

  async embed(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
    if (!texts.length) return []

    const url =
      this.config.localEmbeddingUrl ||
      process.env.LOCAL_EMBEDDING_URL ||
      process.env.EMBEDDING_SERVICE_URL ||
      'http://localhost:8003/embed'
    const model = options.model || this.config.embeddingModel || 'BAAI/bge-m3'

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts, model, normalize: options.normalize ?? true }),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new AiProviderError(
        `Local embedding service error ${resp.status}: ${text.slice(0, 200)}`,
        'api_error',
        resp.status,
      )
    }

    const data: any = await resp.json()
    if (!Array.isArray(data?.embeddings) || data.embeddings.length !== texts.length) {
      throw new AiProviderError('Invalid embedding response shape', 'invalid_response')
    }

    return data.embeddings as number[][]
  }
}

/**
 * Wraps a primary embedding provider and falls back to a secondary provider
 * when the primary fails. Used to keep local bge-m3 as the default while
 * allowing OpenAI as a safety net.
 */
export class ResilientEmbeddingProvider implements Pick<AiProvider, 'embed'> {
  constructor(
    private primary: Pick<AiProvider, 'embed'>,
    private fallback: Pick<AiProvider, 'embed'>,
  ) {}

  async embed(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
    if (!texts.length) return []
    try {
      return await this.primary.embed(texts, options)
    } catch (err) {
      return this.fallback.embed(texts, options)
    }
  }
}
