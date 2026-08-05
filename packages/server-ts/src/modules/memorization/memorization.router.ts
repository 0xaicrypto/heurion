import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import { getUserContext } from '../chat/user-context.js'
import { ChatIngester } from './chat-ingester.service.js'
import { MemoryGraphGateway } from '../../memory/memory-gateway.js'
import prisma from '../../common/prisma.js'

export async function memorizationRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  const ingesterByUser = new Map<string, ChatIngester>()

  function getIngester(userId: string): ChatIngester {
    let ingester = ingesterByUser.get(userId)
    if (!ingester) {
      const ctx = getUserContext(userId)
      // §4.5 (#186): the ingester routes through the gateway so every write
      // lands in the review queue (semantic dedup + human approval).
      const gateway = new MemoryGraphGateway(
        userId,
        ctx.memory,
        ctx.facts,
        ctx.episodes,
        ctx.skills,
        ctx.knowledge,
      )
      ingester = new ChatIngester(ctx.memory, ctx.eventLog, gateway)
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

// 13.5G — memory health metrics.
app.get('/api/v1/memory/health', async (request) => {
  const userId = request.user!.userId
  const ctx = getUserContext(userId)
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString()
  const nowIso = new Date().toISOString()

  const { getCategoryQuality } = await import('../../memory/extraction-quality.js')
  const [quality, byCategory, contradictions, staleRows, archivedRows, graphFacts, graphArticles, gaps] = await Promise.all([
    getCategoryQuality(userId),
    (prisma as any).memoryProposal.findMany({
      where: { userId, status: { in: ['approved', 'rejected'] }, resolvedAt: { not: null } },
      select: { status: true },
    }),
    (prisma as any).memoryProposal.count({
      where: { userId, status: 'pending', conflictsWith: { not: null }, createdAt: { gte: sevenDaysAgo } },
    }),
    (prisma as any).memoryProposal.findMany({
      where: { userId, status: 'pending', archivedAt: null, createdAt: { lt: sevenDaysAgo } },
      select: { importance: true, kind: true },
    }),
    (prisma as any).memoryProposal.count({ where: { userId, archivedAt: { not: null } } }),
    ctx.memory.graph.getCurrentNodesByType('fact'),
    ctx.memory.graph.getCurrentNodesByType('article'),
    (prisma as any).knowledgeGap.count({ where: { userId, status: 'open' } }),
  ])

  const accepted = byCategory.filter((r: any) => r.status === 'approved').length
  const rejected = byCategory.filter((r: any) => r.status === 'rejected').length
  const total = accepted + rejected

  return {
    generated_at: nowIso,
    acceptance: {
      approved: accepted,
      rejected,
      rate: total > 0 ? +(accepted / total).toFixed(3) : null,
      by_category: quality.map((q) => ({ ...q, rate: +q.rate.toFixed(3) })),
    },
    contradictions_7d: contradictions,
    stale: {
      pending_over_7d: staleRows.length,
      high_importance_pinned: staleRows.filter((r: any) => r.kind === 'fact' && (r.importance ?? 3) >= 4).length,
      archived: archivedRows,
    },
    scale: {
      facts: graphFacts.length,
      articles: graphArticles.length,
      open_gaps: gaps,
      pending: staleRows.length + archivedRows,
      episodes: ctx.episodes.all().length,
    },
  }
})
}

