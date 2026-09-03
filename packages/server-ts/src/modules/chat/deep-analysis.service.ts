/**
 * Deep-analysis service (#687) — the orchestration + synthesis LLM call
 * that used to live inline in agent.router.ts. The router only maps HTTP +
 * SSE transport: it passes an `emit` sink and receives the final summary.
 */
import prisma from '../../common/prisma.js'
import { getUserContext } from '../shared/user-context.js'
import { runSubAgent } from '../../tools/subagent-runner.js'
import { deepseekChat, getApiKey } from '../../common/llm.js'
import { resolveTierModel } from '../../common/llm-gateway.js'

export const TOPIC_TASKS: Record<string, string> = {
  literature: 'Review the medical literature for this question and summarize the best available evidence (studies, guidelines, citations with PMIDs).',
  stats: 'Analyze the available data statistically: recommend a test, run it on any retrieved data, and report the result with p-values and effect sizes.',
  clinical: 'Analyze the patient context clinically: findings, medications, contradictions, and next-step recommendations consistent with guidelines.',
}

export interface DeepAnalysisResult {
  summary: string
  totalCost: number
  okCount: number
  failedTopics: string[]
}

/**
 * Run each selected topic as a parallel sub-agent (failures isolated),
 * persist one SubAgentSession row per topic, then synthesize one combined
 * answer. `emit` receives subagent_started/subagent_done per topic (#831:
 * each with a unique id so the UI can group parallel runs).
 */
export async function runDeepAnalysis(input: {
  userId: string
  topics: string[]
  question: string
  context?: string
  patientHash?: string
  emit?: (event: import('@heurion/contracts').SubagentEvent) => void
}): Promise<DeepAnalysisResult> {
  const { userId, question, context, patientHash } = input
  // #831: forward the visibility port into the tool context so sub-agent
  // progress (thinking/tool/summarizing) reaches the SSE stream too.
  const ctx = { ...getUserContext(userId), userId, emitSubagentEvent: input.emit ? (ev: import('@heurion/contracts').SubagentEvent) => input.emit!(ev) : undefined } as ReturnType<typeof getUserContext> & { userId: string; emitSubagentEvent?: (ev: import('@heurion/contracts').SubagentEvent) => void }
  const scope = patientHash ? `patient:${patientHash}` : 'global'

  const results = await Promise.all(
    input.topics.map(async (topic) => {
      const task = `${TOPIC_TASKS[topic]}\n\nQuestion: ${question}${context ? `\nContext: ${context.slice(0, 2000)}` : ''}`
      const id = `deep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      input.emit?.({ type: 'subagent_started', id, task: topic, scope })
      const sessionId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      try {
        const res = await runSubAgent({ task, scope, context, id }, ctx)
        await (prisma as any).subAgentSession.create({
          data: {
            id: sessionId, userId, task, scope, topic,
            summary: res.summary, status: 'done',
            turns: res.turns, costTokens: res.costTokens, createdAt: new Date().toISOString(),
          },
        })
        input.emit?.({
          type: 'subagent_done', id, task: topic, scope, success: true,
          cost_tokens: res.costTokens, turns: res.turns, tool_calls: res.toolCalls,
          summary_preview: res.summary.slice(0, 200),
        })
        return { topic, summary: res.summary, turns: res.turns, costTokens: res.costTokens, failed: false }
      } catch (err) {
        const msg = (err as Error).message.slice(0, 200)
        await (prisma as any).subAgentSession.create({
          data: {
            id: sessionId, userId, task, scope, topic,
            summary: `FAILED: ${msg}`, status: 'failed', turns: 0, costTokens: 0, createdAt: new Date().toISOString(),
          },
        })
        input.emit?.({ type: 'subagent_done', id, task: topic, scope, success: false })
        return { topic, summary: `FAILED: ${msg}`, turns: 0, costTokens: 0, failed: true }
      }
    }),
  )

  const ok = results.filter((r) => !r.failed)
  const failed = results.filter((r) => r.failed)
  const totalCost = results.reduce((a, r) => a + r.costTokens, 0)

  let summary = ''
  if (ok.length > 0) {
    try {
      const parts = ok.map((r) => `## ${r.topic}\n${r.summary}`).join('\n\n')
      const synth = await deepseekChat(
        [{ role: 'user', content: `Combine the following sub-agent findings into one comprehensive answer for the doctor, with clear per-topic sections and clinical implications. Question: ${question}\n\n${parts}` }],
        getApiKey(),
        { model: resolveTierModel('fast'), maxTokens: 2000, telemetryContext: { userId, workspaceId: userId, action: 'deep_analysis.synthesize' } },
      )
      summary = synth.trim()
    } catch {
      // Synthesis unavailable — degrade to concatenation, never fail the turn.
      summary = ok.map((r) => `**[${r.topic}]** ${r.summary}`).join('\n\n')
    }
  }
  if (failed.length > 0) {
    summary += `\n\n⚠️ 以下子任务失败（不影响其他）：${failed.map((f) => f.topic).join(', ')}`
  }

  return { summary, totalCost, okCount: ok.length, failedTopics: failed.map((f) => f.topic) }
}
