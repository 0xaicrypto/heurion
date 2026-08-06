import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import prisma from '../../common/prisma'
import { getUserContext } from './user-context.js'

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
      if (flushed > 0) console.log(`[SESSION] ${flushed} facts flushed on close`)
    } catch (err) {
      console.log('[SESSION] close flush failed:', (err as Error).message.slice(0, 120))
    }

    // 2) Clean up the session's event-log data.
    let cleaned = 0
    try {
      const { getUserContext } = await import('./user-context.js')
      const ctx = getUserContext(userId)
      cleaned = ctx.eventLog.deleteSession(sessionId)
    } catch (err) {
      console.log('[SESSION] event cleanup failed:', (err as Error).message.slice(0, 120))
    }

    return { id: sessionId, status: 'closed', closed_at: now, flushed_facts: flushed, cleaned_events: cleaned }
  })

  app.delete('/api/v1/sessions/:sessionId', async (request) => {
    await prisma.session.deleteMany({ where: { id: (request.params as any).sessionId, userId: request.user!.userId } })
    return {}
  })
}

export async function agentRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  app.get('/api/v1/agent/state', async (request) => {
    const ctx = getUserContext(request.user!.userId)
    return {
      user_id: request.user!.userId,
      on_chain: false,
      memory_count: ctx.facts.all().length,
      episode_count: ctx.episodes.all().length,
      skill_count: ctx.skills.all().filter((s: any) => s.successCount > 0).length,
      anchored_count: 0, pending_anchor_count: 0, failed_anchor_count: 0, total_anchor_count: 0,
      server_time: new Date().toISOString(),
    }
  })

  // Timeline — grouped conversation turns + evolution events
  app.get('/api/v1/agent/timeline', async (request) => {
    const ctx = getUserContext(request.user!.userId)
    const limit = parseInt((request.query as any).limit || '20')
    const all = ctx.eventLog.query({ limit: 200 }).reverse()

    const items: Array<{ kind: string; timestamp: string; summary: string; sync_id: string }> = []

    // 1. Group user+assistant into conversation turns
    let currentTurn: { user?: typeof all[0]; assistant?: typeof all[0] } = {}
    for (const evt of all) {
      if (evt.eventType === 'user_message') {
        if (currentTurn.user) { currentTurn = {} }
        currentTurn.user = evt
      } else if (evt.eventType === 'assistant_response' && currentTurn.user) {
        currentTurn.assistant = evt
        // Create a conversation turn entry
        const summary = currentTurn.user.content.slice(0, 80)
        items.push({
          kind: 'conversation',
          timestamp: new Date(currentTurn.assistant.timestamp * 1000).toISOString(),
          summary: summary + (summary.length >= 80 ? '...' : ''),
          sync_id: `turn_${currentTurn.assistant.idx}`,
        })
        currentTurn = {}
      }
    }

    // 2. Add episode summaries (one per session)
    const episodes = ctx.episodes.all().slice(-5)
    for (const ep of episodes) {
      items.push({
        kind: 'session_summary',
        timestamp: new Date(ep.createdAt).toISOString(),
        summary: `📝 ${ep.summary.slice(0, 100)}`,
        sync_id: `ep_${ep.sessionId}`,
      })
    }

    // 3. Evolution events from event log
    const evolutionEvents = all.filter(e => e.eventType === 'evolution')
    for (const evt of evolutionEvents) {
      items.push({
        kind: 'evolution',
        timestamp: new Date(evt.timestamp * 1000).toISOString(),
        summary: evt.content,
        sync_id: `evo_${evt.idx}`,
      })
    }

    // 4. Overall status
    const facts = ctx.facts.all()
    if (facts.length > 0) {
      items.push({
        kind: 'evolution',
        timestamp: new Date().toISOString(),
        summary: `🧠 ${facts.length} facts accumulated across ${ctx.episodes.all().length} sessions`,
        sync_id: 'evolution_status',
      })
    }

    // Sort by time, newest first, keep only most recent
    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

    return { items: items.slice(0, limit) }
  })

  // Activity feed — memory/knowledge base updates (not chat turns)
  app.get('/api/v1/agent/activity', async (request) => {
    const ctx = getUserContext(request.user!.userId)
    const limit = parseInt((request.query as any).limit || '20')

    const memoryEvents = ctx.eventLog.query({ limit: 200 }).filter(e =>
      e.eventType.startsWith('memory_') || e.eventType.startsWith('kb_'),
    )

    const labelMap: Record<string, string> = {
      memory_fact_added: 'Added fact',
      memory_fact_edited: 'Edited fact',
      memory_fact_deleted: 'Deleted fact',
      memory_article_added: 'Added article',
      memory_article_edited: 'Edited article',
      memory_article_deleted: 'Deleted article',
      memory_document_uploaded: 'Uploaded document',
      memory_document_deleted: 'Deleted document',
      memory_gap_detected: 'Detected gap',
      memory_gap_answered: 'Answered gap',
      memory_patient_deleted: 'Deleted patient data',
    }

    const items: Array<{ kind: string; timestamp: string; summary: string; sync_id: string }> = []

    for (const evt of memoryEvents) {
      const meta = evt.metadata || {}
      const label = labelMap[evt.eventType] || evt.eventType
      let summary = evt.content

      const nodeId = (meta.factId || meta.articleId || meta.documentId || meta.gapId) as string | undefined
      if (nodeId) {
        const node = ctx.memory.graph.getLatestByStableId(nodeId)
        if (node) {
          const content = (node as any).content || (node as any).title || ''
          if (content) {
            summary = `${label}: ${String(content).slice(0, 120)}${String(content).length > 120 ? '…' : ''}`
            continue
          }
        }
      }

      summary = `${label}${evt.content ? ` · ${evt.content}` : ''}`
      items.push({
        kind: evt.eventType,
        timestamp: new Date(evt.timestamp * 1000).toISOString(),
        summary,
        sync_id: `mem_${evt.idx}`,
      })
    }

    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    return { items: items.slice(0, limit) }
  })

  app.get('/api/v1/agent/messages', async (request) => {
    const ctx = getUserContext(request.user!.userId)
    const sessionId = (request.query as any).session_id
    // No session selected → nothing to return (an empty session_id would
    // otherwise leak every session's messages).
    if (!sessionId) {
      return { messages: [], total: 0 }
    }
    // R3: tool_call/tool_result events stay OUT of the chat message stream
    // so the reconstructed conversation remains structurally compatible.
    const events = ctx.eventLog
      .query({ sessionId, limit: parseInt((request.query as any).limit || '100', 10) })
      .filter((e: any) => e.eventType !== 'tool_call' && e.eventType !== 'tool_result')
      .reverse()
    return {
      messages: events.map(e => ({
        role: e.eventType === 'user_message' ? 'user' : 'assistant',
        content: e.content,
        timestamp: new Date(e.timestamp * 1000).toISOString(),
        sync_id: String(e.idx), metadata: e.metadata,
      })),
      total: events.length,
    }
  })

  // R3: replay the persisted tool-call state machine for a session.
  app.get('/api/v1/agent/tool-events', async (request) => {
    const ctx = getUserContext(request.user!.userId)
    const sessionId = (request.query as any).session_id
    const events = ctx.eventLog
      .query({ sessionId })
      .filter((e: any) => e.eventType === 'tool_call' || e.eventType === 'tool_result')
      .sort((a: any, b: any) => a.idx - b.idx)
    return {
      events: events.map(e => ({
        idx: e.idx,
        type: e.eventType,
        content: e.content,
        metadata: e.metadata || {},
        timestamp: new Date(e.timestamp * 1000).toISOString(),
      })),
      total: events.length,
    }
  })

  // U3: current context budget usage for a session, so the UI can show the
  // indicator immediately on load (without waiting for the next chat turn).
  app.get('/api/v1/agent/context-usage', async (request) => {
    const ctx = getUserContext(request.user!.userId)
    const sessionId = (request.query as any).session_id
    const maxHistoryTokens = parseInt(process.env.MAX_HISTORY_TOKENS || '8000', 10)
    const historyTurns = parseInt(process.env.HISTORY_TURNS || '20', 10)
    const history = ctx.eventLog.query({ sessionId, limit: historyTurns * 2 }).reverse()
    const { buildHistoryMessages } = await import('../../retrieval/context-compressor.js')
    const { omittedTurns, tokens } = buildHistoryMessages(history, {
      maxTokens: maxHistoryTokens,
      maxTurns: historyTurns,
    })
    return {
      history_tokens: tokens,
      history_budget: maxHistoryTokens,
      history_turns: historyTurns,
      omitted_turns: omittedTurns,
      will_compact: omittedTurns > 0 || history.length >= historyTurns * 2,
    }
  })
}
