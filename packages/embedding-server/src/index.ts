import Fastify from 'fastify'
import { EmbeddingService, type EmbeddingConfig } from './embedding.service.js'

function envBool(value: string | undefined, defaultVal: boolean): boolean {
  if (value === undefined) return defaultVal
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function loadConfig(): EmbeddingConfig & { host: string; port: number } {
  return {
    model: process.env.EMBEDDING_MODEL || 'Xenova/bge-small-en-v1.5',
    batchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE || '32', 10),
    normalize: envBool(process.env.EMBEDDING_NORMALIZE, true),
    host: process.env.EMBEDDING_SERVER_HOST || '0.0.0.0',
    port: parseInt(process.env.EMBEDDING_SERVER_PORT || '8003', 10),
  }
}

async function main() {
  const config = loadConfig()
  const service = new EmbeddingService(config)

  const app = Fastify({ logger: true })

  app.get('/health', async () => ({
    status: 'ok',
    model: service.getModelName(),
    dimensions: service.getDimensions(),
    device: service.getDevice(),
    quantization: 'none',
  }))

  app.post<{ Body: { texts: string[]; model?: string; normalize?: boolean } }>(
    '/embed',
    async (request, reply) => {
      const { texts, normalize } = request.body
      if (!texts || !Array.isArray(texts) || texts.length === 0) {
        return reply.status(400).send({ error: 'texts must be a non-empty array' })
      }

      try {
        const start = Date.now()
        const result = await service.embed(texts, normalize)
        request.log.info(
          { texts: texts.length, dims: result.dimensions, ms: Date.now() - start },
          'embedding complete',
        )
        return {
          embeddings: result.embeddings,
          model: service.getModelName(),
          dimensions: result.dimensions,
        }
      } catch (err: any) {
        request.log.error(err, 'embedding failed')
        return reply.status(500).send({ error: err.message || 'Embedding failed' })
      }
    },
  )

  await service.load()
  await app.listen({ host: config.host, port: config.port })
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
