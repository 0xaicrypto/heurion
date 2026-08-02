import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import { getUserContext } from '../chat/user-context.js'
import { ChatIngester } from './chat-ingester.service.js'

export async function memorizationRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  const ingesterByUser = new Map<string, ChatIngester>()

  function getIngester(userId: string): ChatIngester {
    let ingester = ingesterByUser.get(userId)
    if (!ingester) {
      const ctx = getUserContext(userId)
      ingester = new ChatIngester(ctx.memory, ctx.eventLog)
      ingesterByUser.set(userId, ingester)
    }
    return ingester
  }

  app.post('/api/v1/memorization/ingest', async (request, reply) => {
    const { text, patient_hash, encounter_id } = request.body as any
    if (!text) return reply.status(400).send({ error: 'text required' })
    const userId = request.user!.userId
    const ingester = getIngester(userId)
    const result = await ingester.ingestEncounter({
      userId,
      patientHash: patient_hash,
      encounterId: encounter_id || `manual_${Date.now()}`,
      sourceText: text,
    })
    return result
  })

  app.post('/api/v1/memorization/extract', async (request, reply) => {
    const { text } = request.body as any
    if (!text) return reply.status(400).send({ error: 'text required' })
    const { extractClinicalEntities } = await import('./clinical-extractor.service.js')
    const result = await extractClinicalEntities(text)
    return {
      entities: result.entities,
      raw_count: result.rawCount,
      drops: result.drops,
      latency_ms: result.latencyMs,
    }
  })

  /**
   * Session-end closure: summarize a session's conversation and route the
   * summary through the pending review queue (#114). Returns the summary
   * immediately so the runtime can keep using it as context.
   */
  app.post('/api/v1/memorization/sessions/:sessionId/summarize', async (request, reply) => {
    const userId = request.user!.userId
    const { sessionId } = request.params as any
    const { patient_hash, limit } = request.body as any

    const ctx = getUserContext(userId)
    const events = ctx.eventLog.query({ sessionId, limit: parseInt(limit || '80', 10) }).reverse()
    const conversation = events
      .filter((e: any) => e.eventType === 'user_message' || e.eventType === 'assistant_response')
      .map((e: any) => `${e.eventType === 'user_message' ? 'USER' : 'AI'}: ${String(e.content || '').slice(0, 500)}`)
      .join('\n')

    if (!conversation.trim()) {
      return reply.status(400).send({ error: 'No conversation events found for this session' })
    }

    const { MemoryGraphGateway } = await import('../../memory/memory-gateway.js')
    const gateway = new MemoryGraphGateway(
      userId,
      ctx.memory,
      ctx.facts,
      ctx.episodes,
      ctx.skills,
      ctx.knowledge,
    )
    const result = await gateway.summarize({
      conversation,
      sessionId,
      patientHash: patient_hash,
    })
    return { ...result, session_id: sessionId }
  })
}
