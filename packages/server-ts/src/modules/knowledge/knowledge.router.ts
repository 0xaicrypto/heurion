import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import { PrismaKnowledgeGapService } from './knowledge-gap.service'
import { getUserContext } from '../chat/user-context.js'

const gapService = new PrismaKnowledgeGapService()

export async function knowledgeRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // List knowledge gaps for the current user's workspace
  app.get('/api/v1/knowledge/gaps', async (request) => {
    const userId = request.user!.userId
    const status = (request.query as any).status || 'open'
    const gaps = await gapService.list({ workspaceId: userId, status })
    return { gaps }
  })

  // Create a knowledge gap (user-initiated)
  app.post('/api/v1/knowledge/gaps', async (request, reply) => {
    const userId = request.user!.userId
    const body = request.body as any
    if (!body?.content) {
      return reply.status(400).send({ error: 'content required' })
    }

    const gap = await gapService.create({
      userId,
      workspaceId: userId,
      content: body.content,
      source: body.source || 'user',
      sourceId: body.sourceId,
    })
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
    return updated
  })
}
