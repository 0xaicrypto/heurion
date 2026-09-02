import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import prisma from '../../common/prisma'
import { getUserContext } from '../shared/user-context.js'
import { makeLogger } from '../../common/logger.js'

const log = makeLogger('chat.session')

export async function sessionRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  app.get('/api/v1/sessions', async (request) => {
    const includeArchived = (request.query as any).include_archived === '1'
    const scope = (request.query as any).scope
    // Writing sessions (doc-*) are internal namespaces — never list them;
    // legacy global-* default sessions were removed as a concept.
    const where: any = {
      userId: request.user!.userId,
      archived: includeArchived ? undefined : 0,
      NOT: { id: { startsWith: 'doc-' } },
    }
    if (scope) where.scope = scope
    const allRows = await prisma.session.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
    })
    const rows = allRows.filter((s: any) => !String(s.id).startsWith('global-'))
    return {
      sessions: rows.map(s => ({
        id: s.id, title: s.title,
        scope: s.scope, patient_hash: s.patientHash,
        status: s.status,
        created_at: s.createdAt, updated_at: s.lastMessageAt,
        closed_at: s.closedAt,
        archived: s.archived === 1, message_count: s.messageCount,
      })),
    }
  })

  app.post('/api/v1/sessions', async (request) => {
    const { title, scope, patient_hash } = request.body as any
    const id = `session_${Math.random().toString(36).slice(2, 10)}`
    const now = new Date().toISOString()
    await prisma.session.create({
      data: {
        id, userId: request.user!.userId,
        title: title || 'New Session',
        scope: scope === 'patient' ? 'patient' : 'global',
        patientHash: patient_hash || null,
        status: 'open',
        createdAt: now,
      },
    })
    return {
      id, title: title || 'New Session',
      scope: scope === 'patient' ? 'patient' : 'global',
      patient_hash: patient_hash || null,
      status: 'open',
      created_at: now, message_count: 0, archived: false,
    }
  })

  /**
   * Close a session: summarize the conversation into the pending queue
   * (sync, so the summary is durable before cleanup), then remove the
   * session's event-log data. status → closed, no more writes.
   */
  app.post('/api/v1/sessions/:sessionId/close', async (request, reply) => {
    const { sessionId } = request.params as any
    const userId = request.user!.userId
    const now = new Date().toISOString()

    const updated = await prisma.session.updateMany({
      where: { id: sessionId, userId, status: 'open' },
      data: { status: 'closed', closedAt: now },
    })
    let patientHash: string | undefined
    if (updated.count === 0) {
      const existing = await prisma.session.findFirst({ where: { id: sessionId, userId } })
      if (!existing) {
        // Legacy global-* default-session namespaces: the concept was
        // removed — closing one deletes its row outright so it can never
        // reappear in the session list.
        if (sessionId.startsWith('global-')) {
          await prisma.session.deleteMany({ where: { id: sessionId, userId } })
        } else {
          return reply.status(404).send({ error: 'Session not found' })
        }
      } else {
        return { id: sessionId, status: existing.status, already: true }
      }
    } else {
      const row = await prisma.session.findFirst({ where: { id: sessionId, userId } })
      patientHash = row?.patientHash ?? undefined
    }

    // 1) Tier-3 flush: extract any segment not yet covered by the
    //     incremental cursor or a compaction, before the event log is wiped
    //     (short sessions must not lose memory).
    let flushed = 0
    try {
      const ctx = getUserContext(userId)
      flushed = await ctx.orchestrator.extractUnextractedSegment(userId, sessionId, patientHash)
      if (flushed > 0) log.info(`[SESSION] ${flushed} facts flushed on close`)
    } catch (err) {
      log.info('[SESSION] close flush failed:', (err as Error).message.slice(0, 120))
    }

    // 2) Clean up the session's event-log data.
    let cleaned = 0
    try {
      const { getUserContext } = await import('../shared/user-context.js')
      const ctx = getUserContext(userId)
      cleaned = ctx.eventLog.deleteSession(sessionId)
    } catch (err) {
      log.info('[SESSION] event cleanup failed:', (err as Error).message.slice(0, 120))
    }

    return { id: sessionId, status: 'closed', closed_at: now, flushed_facts: flushed, cleaned_events: cleaned }
  })

  app.delete('/api/v1/sessions/:sessionId', async (request, reply) => {
    // 边界审计（#253）: userId-scoped; a miss must 404, never a silent 200.
    const deleted = await prisma.session.deleteMany({ where: { id: (request.params as any).sessionId, userId: request.user!.userId } })
    if (deleted.count === 0) {
      return reply.status(404).send({ error: 'Session not found' })
    }
    return {}
  })
}
