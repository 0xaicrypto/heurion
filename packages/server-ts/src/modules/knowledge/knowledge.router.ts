import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import { PrismaKnowledgeGapService, type GapSource } from './knowledge-gap.service'
import { getUserContext } from '../chat/user-context.js'
import { SidecarFeedbackService, type SidecarOutputType } from './sidecar-feedback.service.js'
import { PrismaTelemetryService } from './telemetry.service.js'

const gapService = new PrismaKnowledgeGapService()
const telemetry = new PrismaTelemetryService()

function parseQueryInt(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? parseInt(value, 10) : typeof value === 'number' ? value : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export async function knowledgeRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // List knowledge gaps for the current user's workspace (paginated + filterable)
  app.get('/api/v1/knowledge/gaps', async (request) => {
    const userId = request.user!.userId
    const q = request.query as any
    const result = await gapService.list({
      workspaceId: userId,
      status: q.status || 'open',
      source: q.source || 'all',
      q: q.q,
      page: parseQueryInt(q.page, 1),
      pageSize: parseQueryInt(q.pageSize, 50),
      sortBy: q.sortBy === 'updatedAt' ? 'updatedAt' : 'createdAt',
      sortOrder: q.sortOrder === 'asc' ? 'asc' : 'desc',
    })
    return result
  })

  // Knowledge gap dashboard stats
  app.get('/api/v1/knowledge/gaps/dashboard', async (request) => {
    const userId = request.user!.userId
    const stats = await gapService.getStats(userId)
    return stats
  })

  // Suggest an answer for a knowledge gap from existing facts/knowledge
  app.get('/api/v1/knowledge/gaps/:id/suggest', async (request, reply) => {
    const userId = request.user!.userId
    const { id } = request.params as { id: string }

    const gap = await gapService.getById(id)
    if (!gap) {
      return reply.status(404).send({ error: 'gap not found' })
    }
    if (gap.userId !== userId) {
      return reply.status(403).send({ error: 'forbidden' })
    }

    const ctx = getUserContext(userId)
    const suggestions = await gapService.suggestAnswer(id, ctx.facts.all(), ctx.knowledge.all())
    return { suggestions }
  })

  // Create a knowledge gap (user-initiated)
  app.post('/api/v1/knowledge/gaps', async (request, reply) => {
    const userId = request.user!.userId
    const body = request.body as any
    if (!body?.content) {
      return reply.status(400).send({ error: 'content required' })
    }

    const source = (body.source || 'user') as GapSource
    const gap = await gapService.create({
      userId,
      workspaceId: userId,
      content: body.content,
      source,
      sourceId: body.sourceId,
    })

    await telemetry.record({
      userId,
      workspaceId: userId,
      category: 'gap',
      action: 'created',
      metadata: { source, sourceId: body.sourceId },
    }).catch(() => {})

    return gap
  })

  // Answer a knowledge gap: mark as answered and save the answer as a fact
  app.post('/api/v1/knowledge/gaps/:id/answer', async (request, reply) => {
    const userId = request.user!.userId
    const { id } = request.params as { id: string }
    const body = request.body as any
    if (!body?.answer) {
      return reply.status(400).send({ error: 'answer required' })
    }

    const gap = await gapService.getById(id)
    if (!gap) {
      return reply.status(404).send({ error: 'gap not found' })
    }
    if (gap.userId !== userId) {
      return reply.status(403).send({ error: 'forbidden' })
    }

    const ctx = getUserContext(userId)
    const fact = ctx.facts.add({
      category: 'fact',
      importance: 4,
      content: body.answer,
      sourceType: 'doctor',
    })
    ctx.facts.commit()

    const updated = await gapService.resolve(id, body.answer)
    if (!updated) {
      return reply.status(500).send({ error: 'failed to resolve gap' })
    }

    await telemetry.record({
      userId,
      workspaceId: userId,
      category: 'gap',
      action: 'answered',
      metadata: { gapId: id, factId: fact.id },
    }).catch(() => {})

    return {
      ...updated,
      answerId: fact.id,
      status: 'answered',
    }
  })

  // Ignore a knowledge gap
  app.post('/api/v1/knowledge/gaps/:id/ignore', async (request, reply) => {
    const userId = request.user!.userId
    const { id } = request.params as { id: string }

    const gap = await gapService.getById(id)
    if (!gap) {
      return reply.status(404).send({ error: 'gap not found' })
    }
    if (gap.userId !== userId) {
      return reply.status(403).send({ error: 'forbidden' })
    }

    const updated = await gapService.ignore(id)
    if (!updated) {
      return reply.status(500).send({ error: 'failed to ignore gap' })
    }

    await telemetry.record({
      userId,
      workspaceId: userId,
      category: 'gap',
      action: 'ignored',
      metadata: { gapId: id },
    }).catch(() => {})

    return updated
  })

  // Sidecar output feedback: extract candidates and optionally save facts
  app.post('/api/v1/knowledge/sidecar/feedback', async (request, reply) => {
    const userId = request.user!.userId
    const body = request.body as any
    if (!body?.output || typeof body.output !== 'string') {
      return reply.status(400).send({ error: 'output required' })
    }

    const ctx = getUserContext(userId)
    const service = new SidecarFeedbackService(ctx.facts)
    const result = await service.process({
      userId,
      workspaceId: userId,
      output: body.output,
      outputType: (body.outputType || 'unknown') as SidecarOutputType,
      saveAll: body.saveAll === true,
      sourceId: body.sourceId,
    })

    await telemetry.record({
      userId,
      workspaceId: userId,
      category: 'kb_command',
      action: 'sidecar_feedback',
      metadata: {
        outputType: body.outputType,
        saveAll: body.saveAll === true,
        candidateCount: result.candidates.length,
        savedCount: result.saved.length,
      },
    }).catch(() => {})

    return result
  })

  // Telemetry dashboard
  app.get('/api/v1/knowledge/telemetry/dashboard', async (request) => {
    const userId = request.user!.userId
    const q = request.query as any
    return telemetry.dashboard(userId, q.from, q.to)
  })

  // Telemetry query (recent events)
  app.get('/api/v1/knowledge/telemetry', async (request) => {
    const userId = request.user!.userId
    const q = request.query as any
    return {
      events: await telemetry.query({
        workspaceId: userId,
        category: q.category,
        action: q.action,
        from: q.from,
        to: q.to,
        limit: parseQueryInt(q.limit, 100),
      }),
    }
  })
}
