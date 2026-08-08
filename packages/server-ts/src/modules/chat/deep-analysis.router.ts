/**
 * #420: parallel deep analysis — spawn several constrained sub-agents
 * concurrently (Promise.all), persist their results (SubAgentSession),
 * then have the main agent synthesize one combined answer with per-topic
 * breakdowns. SSE events carry cost + scope so the UI can show progress
 * per sub-agent.
 */
import { FastifyRequest, FastifyReply } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import prisma from '../../common/prisma.js'
import { createSseSender } from './chat-sse.js'
import { runSubAgent } from '../../tools/subagent-runner.js'
import { getUserContext } from './user-context.js'
import { deepseekChat, getApiKey, DEEPSEEK_CHAT_MODEL } from '../../common/llm.js'

const TOPIC_TASKS: Record<string, string> = {
  literature: 'Review the medical literature for this question and summarize the best available evidence (studies, guidelines, citations with PMIDs).',
  stats: 'Analyze the available data statistically: recommend a test, run it on any retrieved data, and report the result with p-values and effect sizes.',
  clinical: 'Analyze the patient context clinically: findings, medications, contradictions, and next-step recommendations consistent with guidelines.',
}

export async function deepAnalysisRouter(app: any) {
  app.addHook('preHandler', authGuard)

  // ── Parallel deep analysis ─────────────────────────────────────────
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
    const ctx = { ...getUserContext(userId), userId }
    const scope = patient_hash ? `patient:${patient_hash}` : 'global'

    const sender = createSseSender(reply)
    const send = sender.send

    // Kick off all sub-agents in parallel; each failure is isolated.
    const results = await Promise.all(
      selected.map(async (topic) => {
        const task = `${TOPIC_TASKS[topic]}\n\nQuestion: ${questionText}${context ? `\nContext: ${context.slice(0, 2000)}` : ''}`
        send({ type: 'subagent_started', task: topic, scope })
        const sessionId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        try {
          const res = await runSubAgent({ task, scope, context }, ctx)
          await (prisma as any).subAgentSession.create({
            data: {
              id: sessionId, userId, task, scope, topic,
              summary: res.summary, status: 'done',
              turns: res.turns, costTokens: res.costTokens, createdAt: new Date().toISOString(),
            },
          })
          send({ type: 'subagent_done', task: topic, success: true, cost_tokens: res.costTokens })
          return { topic, summary: res.summary, turns: res.turns, costTokens: res.costTokens, failed: false }
        } catch (err) {
          const msg = (err as Error).message.slice(0, 200)
          await (prisma as any).subAgentSession.create({
            data: {
              id: sessionId, userId, task, scope, topic,
              summary: `FAILED: ${msg}`, status: 'failed', turns: 0, costTokens: 0, createdAt: new Date().toISOString(),
            },
          })
          send({ type: 'subagent_done', task: topic, success: false })
          return { topic, summary: `FAILED: ${msg}`, turns: 0, costTokens: 0, failed: true }
        }
      }),
    )

    // Synthesize one combined answer (主 agent 聚合).
    send({ type: 'context_info', text: '所有子任务完成，正在汇总…', kind: 'router' })
    const ok = results.filter((r) => !r.failed)
    const failed = results.filter((r) => r.failed)
    const totalCost = results.reduce((a, r) => a + r.costTokens, 0)

    let summary = ''
    if (ok.length > 0) {
      try {
        const parts = ok.map((r) => `## ${r.topic}\n${r.summary}`).join('\n\n')
        const synth = await deepseekChat(
          [{ role: 'user', content: `Combine the following sub-agent findings into one comprehensive answer for the doctor, with clear per-topic sections and clinical implications. Question: ${questionText}\n\n${parts}` }],
          getApiKey(),
          { model: DEEPSEEK_CHAT_MODEL, maxTokens: 2000, telemetryContext: { userId, workspaceId: userId, action: 'deep_analysis.synthesize' } },
        )
        summary = synth.trim()
      } catch {
        summary = ok.map((r) => `**[${r.topic}]** ${r.summary}`).join('\n\n')
      }
    }
    if (failed.length > 0) {
      summary += `\n\n⚠️ 以下子任务失败（不影响其他）：${failed.map((f) => f.topic).join(', ')}`
    }

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
