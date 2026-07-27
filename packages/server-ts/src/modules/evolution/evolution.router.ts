import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import type { EvolutionQueue } from './evolution.queue.js'

export interface EvolutionRouterOptions {
  evolutionQueue?: EvolutionQueue
}

/**
 * Exposes the evolution queue status and metrics.
 * Useful for monitoring backlog, active jobs, and failed turns.
 */
export async function evolutionRouter(app: FastifyInstance, opts: EvolutionRouterOptions = {}) {
  app.addHook('preHandler', authGuard)

  app.get('/api/v1/evolution/queue', async (request, reply) => {
    const queue = opts.evolutionQueue ?? (app as any).evolutionQueue
    if (!queue) {
      return reply.status(503).send({ error: 'Evolution queue not available' })
    }

    const metrics = await queue.getMetrics()
    return {
      type: queue.type,
      metrics,
    }
  })
}
