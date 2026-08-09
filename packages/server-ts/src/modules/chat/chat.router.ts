import { FastifyInstance } from 'fastify'
import { makeLogger } from '../../common/logger.js'
import { authGuard } from '../../common/auth.guard'
import prisma from '../../common/prisma'
import { getUserContext } from './user-context.js'
import { chatSendSchema, memoryImportSchema } from './chat.dto.js'
import { handleAgentChat } from './chat-handler.js'
import { PrismaTelemetryService } from '../knowledge/telemetry.service.js'
import { type EvolutionQueue } from '../evolution/evolution.queue.js'

const telemetry = new PrismaTelemetryService()

export interface ChatRouterOptions {
  evolutionQueue?: EvolutionQueue
}

const log = makeLogger('chat.router')

export async function chatRouter(app: FastifyInstance, opts: ChatRouterOptions = {}) {
  app.addHook('preHandler', authGuard)

  app.post('/api/v1/agent/chat', async (request, reply) => {
    // #349: zod-validated body — bad input is rejected at the entry.
    const parsed = chatSendSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: `Invalid request: ${parsed.error.issues[0]?.message || 'validation failed'}` })
    }
    await handleAgentChat(request, reply, { evolutionQueue: opts.evolutionQueue })
  })

  // #6: Memory export
  app.get('/api/v1/memory/export', async (request, reply) => {
    const ctx = getUserContext(request.user!.userId)
    reply.header('Content-Type', 'application/json')
    reply.header('Content-Disposition', 'attachment; filename="heurion-memory.json"')
    return {
      exported_at: new Date().toISOString(),
      facts: ctx.facts.all(),
      episodes: ctx.episodes.all(),
      skills: ctx.skills.all(),
      event_log_count: ctx.eventLog.count(),
    }
  })

  // #6: Memory import
  app.post('/api/v1/memory/import', async (request, reply) => {
    const ctx = getUserContext(request.user!.userId)
    // #349: zod-validated import payload.
    const parsed = memoryImportSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: `Invalid import: ${parsed.error.issues[0]?.message || 'validation failed'}` })
    }
    const data = parsed.data
    let imported = 0
    if (data.facts && Array.isArray(data.facts)) {
      for (const f of data.facts) {
        ctx.memory.addFact(
          {
            content: f.content,
            category: f.category,
            importance: f.importance,
            sourceType: f.sourceType,
            patientHash: f.patientHash,
            studyId: f.studyId,
          },
          'import',
        )
        imported++
      }
    }
    if (data.episodes && Array.isArray(data.episodes)) {
      for (const e of data.episodes) { ctx.episodes.upsert(e.sessionId || '', e.summary || '', e.turnCount || 0); imported++ }
    }
    ctx.facts.commit()
    ctx.episodes.commit()
    return { imported, facts_count: ctx.facts.all().length, episodes_count: ctx.episodes.all().length }
  })

  app.get('/api/v1/chat/projection', async (request) => {
    const ctx = getUserContext(request.user!.userId)
    const result = await ctx.orchestrator['projection'].project({
      userId: request.user!.userId, patientHash: null, sessionId: 'debug',
      persona: 'debug', facts: ctx.facts.all(), episodes: ctx.episodes.all(), skills: ctx.skills.all(),
    })
    return result
  })
}

