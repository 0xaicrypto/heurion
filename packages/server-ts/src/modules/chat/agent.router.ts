/**
 * #667: single router for the whole `/api/v1/agent/*` surface.
 * Previously fragmented across chat.router.ts (agent/chat),
 * session-agent.router.ts (state/timeline/activity/messages/…) and
 * deep-analysis.router.ts (agent/deep-analysis) — one prefix, one file.
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import prisma from '../../common/prisma'
import { MAX_HISTORY_TOKENS } from './chat-context.js'
import { getUserContext } from './user-context.js'
import { chatSendSchema } from './chat.dto.js'
import { handleAgentChat } from './chat-handler.js'
import { type EvolutionQueue } from '../evolution/evolution.queue.js'
import { createSseSender } from './chat-sse.js'
// #687: deep-analysis 编排/LLM 收敛到 service,TOPIC_TASKS 从 service 导入。
import { TOPIC_TASKS, runDeepAnalysis } from './deep-analysis.service.js'

export interface AgentRouterOptions {
  evolutionQueue?: EvolutionQueue
}

export async function agentRouter(app: FastifyInstance, opts: AgentRouterOptions = {}) {
  app.addHook('preHandler', authGuard)

  // ── Chat ────────────────────────────────────────────────────────────
  app.post('/api/v1/agent/chat', async (request, reply) => {
    // #349: zod-validated body — bad input is rejected at the entry.
    const parsed = chatSendSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: `Invalid request: ${parsed.error.issues[0]?.message || 'validation failed'}` })
    }
    await handleAgentChat(request, reply, { evolutionQueue: opts.evolutionQueue })
  })

  // ── State / timeline / activity ─────────────────────────────────────
  app.get('/api/v1/agent/state', async (request) => {
    const ctx = getUserContext(request.user!.userId)
    return {
      user_id: request.user!.userId,
      memory_count: ctx.facts.all().length,
      episode_count: ctx.episodes.all().length,
      skill_count: ctx.skills.all().filter((s: any) => s.successCount > 0).length,
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

  // #598: 上传附件即写入会话历史(作为 user_message)— 刷新后聊天记录
  // 可见"已上传文件",附件信息随消息恢复。
  app.post('/api/v1/agent/attachments/log', async (request) => {
    const ctx = getUserContext(request.user!.userId)
    const { session_id, files } = request.body as any
    if (!session_id || !Array.isArray(files) || files.length === 0) {
      return { logged: false }
    }
    const names = files.map((f: any) => String(f.name || f.file_id || 'file')).filter(Boolean)
    ctx.eventLog.append({
      timestamp: Date.now() / 1000,
      eventType: 'user_message',
      content: `[📎 已上传] ${names.join(', ')}`,
      metadata: { attachment: true, fileIds: files.map((f: any) => String(f.file_id || '')) },
      agentId: request.user!.userId,
      sessionId: session_id,
    })
    return { logged: true, names }
  })

  // ── Message / tool replay ───────────────────────────────────────────
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
    // #583: turn/intent-decode is a log-only audit event, never a chat message.
    const events = ctx.eventLog
      .query({ sessionId, limit: parseInt((request.query as any).limit || '100', 10) })
      .filter((e: any) => e.eventType !== 'tool_call' && e.eventType !== 'tool_result' && e.eventType !== 'turn/intent-decode')
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
    // Boundary guard: without a session_id the EventLog query would return
    // every session's tool events (same leak class as #251).
    if (!sessionId) {
      return { events: [], total: 0 }
    }
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
    // Boundary guard: without a session_id this would aggregate history
    // across every session (same leak class as #251).
    if (!sessionId) {
      return {
        history_tokens: 0,
        history_budget: MAX_HISTORY_TOKENS,
        history_turns: parseInt(process.env.HISTORY_TURNS || '20', 10),
        omitted_turns: 0,
        will_compact: false,
      }
    }
    const maxHistoryTokens = MAX_HISTORY_TOKENS
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

  // ── Parallel deep analysis (#420; orchestration in deep-analysis.service) ──
  app.post('/api/v1/agent/deep-analysis', async (request: FastifyRequest, reply: FastifyReply) => {
    const { patient_hash, topics, context, question } = request.body as {
      patient_hash?: string
      topics?: string[]
      context?: string
      question?: string
    }
    const selected = (topics || ['literature', 'clinical']).filter((t) => TOPIC_TASKS[t])
    if (selected.length === 0) return reply.status(400).send({ error: 'no valid topics (literature|stats|clinical)' })
    const questionText = question || String((request.body as any)?.text || '')
    if (!questionText.trim()) return reply.status(400).send({ error: 'question required' })

    const userId = request.user!.userId

    const sender = createSseSender(reply)
    const send = sender.send

    // #687: 编排/持久化/汇总 LLM 在 service — router 只做 SSE 投影。
    const { summary, totalCost } = await runDeepAnalysis({
      userId,
      topics: selected,
      question: questionText,
      context,
      patientHash: patient_hash,
      emit: (event) => {
        if (event.type === 'subagent_started') {
          send({ type: 'subagent_started', task: event.task, scope: event.scope })
        } else {
          send({ type: 'subagent_done', task: event.task, success: event.success ?? false, cost_tokens: event.cost_tokens ?? 0 })
        }
      },
    })

    send({ type: 'context_info', text: '所有子任务完成，正在汇总…', kind: 'router' })
    send({ type: 'final_answer_chunk', text: summary })
    send({ type: 'subagent_done', task: 'synthesis', success: true, cost_tokens: totalCost })
    send({ type: 'turn_complete' })
    sender.end()
  })

  // ── Sub-agent session history ──────────────────────────────────────
  app.get('/api/v1/agent/subagent-sessions', async (request: FastifyRequest) => {
    const rows = await (prisma as any).subAgentSession.findMany({
      where: { userId: request.user!.userId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    })
    return {
      sessions: rows.map((r: any) => ({
        id: r.id, task: r.task, topic: r.topic, scope: r.scope,
        summary: r.summary, status: r.status, turns: r.turns,
        cost_tokens: r.costTokens, created_at: r.createdAt,
      })),
    }
  })
}
