import { FastifyInstance } from 'fastify'
import { makeLogger } from '../../common/logger.js'
import { authGuard } from '../../common/auth.guard'
import prisma from '../../common/prisma'
import { getUserContext, buildCachedPersona, buildFileContext } from './user-context.js'
import { deepseekStream, deepseekChat, getApiKey, DEEPSEEK_PREMIUM_MODEL } from '../../common/llm.js'
import { chatSendSchema, memoryImportSchema } from './chat.dto.js'
import { analyzeChatForPatient, updatePatientFromFindings } from '../patients/clinical-analysis.js'
import { router, createDefaultLLMClassifier } from '../../retrieval/query-router.js'
import { buildHistoryMessages } from '../../retrieval/context-compressor.js'
import { estimateTokens } from '../../common/token-estimate.js'
import { detectDoomLoop } from '../../tools/doom-loop.js'
import { ensureSessionCompaction, getInFlightCompaction } from '../../memory/compaction/index.js'
import { handleKnowledgeCommand, type CommandResult } from '../knowledge/knowledge-command-handler.js'
import { handleAgentChat } from './chat-handler.js'
import { handlePluginChatRequest } from '../plugins/plugin-chat-handler.js'
import { PrismaKnowledgeGapService } from '../knowledge/knowledge-gap.service.js'
import { PrismaTelemetryService } from '../knowledge/telemetry.service.js'
import { type EvolutionQueue } from '../evolution/evolution.queue.js'
import { ToolRegistry, type ToolContext } from '../../tools/tool-registry.js'
import type { ToolDefinition } from '../../tools/base-tool.js'
import fs from 'fs'
import path from 'path'
import { extractTextFromUpload } from '../../lib/document-extractor.js'

// #2: Read uploaded file content for chat context
const gapService = new PrismaKnowledgeGapService()
const telemetry = new PrismaTelemetryService()

function formatCommandResult(result: CommandResult): string {
  switch (result.type) {
    case 'kb_search_result':
      return result.summary
    case 'kb_remembered':
      return `✅ 已记录为 Fact #${result.factId}（置信度 ${Math.round(result.confidence * 100)}%）`
    case 'kb_pending_confirmation':
      return `⚠️ 请确认是否记录："${result.candidate}"（置信度 ${Math.round(result.confidence * 100)}%）`
    case 'kb_summary':
      return result.summary
    case 'kb_gaps':
      if (result.gaps.length === 0) return '当前没有未解问题。'
      return `未解问题（${result.gaps.length}）：\n` +
        result.gaps.map((g, i) => `${i + 1}. ${g.content}`).join('\n')
    case 'error':
      return `❌ ${result.message}`
    default:
      return '命令已处理。'
  }
}

async function readAttachmentContent(userId: string, fileId: string): Promise<string> {
  const name = fileId.split('_').slice(1).join('_') || fileId
  const text = await extractTextFromUpload(userId, fileId, { maxChars: 15000 })
  if (!text) return ''
  return `\n[ATTACHMENT: ${name}]\n${text}\n[/ATTACHMENT]\n`
}

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

/**
 * Select which accumulated-memory layers to inject based on the router intent.
 * This keeps per-turn context cost predictable.
 *
 * Episodes (session summaries) are un-reviewed conversation memory — by
 * design they serve the CURRENT session only (BRAIN2_MEMORY_LIFECYCLE §5.3,
 * "不确认的摘要仅用于本轮上下文"). A new session must never inherit another
 * session's un-approved summaries, so episodes are filtered by sessionId.
 */
/**
 * §3.4 (#194): total context budget enforcement. Trims non-system messages
 * oldest-first until the estimate fits; falls back to truncating the system
 * prompt. Returns the number of trimmed messages.
 */
export function enforceTotalBudget(
  msgs: Array<{ role: string; content: string }>,
  maxTokens: number,
): number {
  if (maxTokens <= 0) return 0
  let tokens = estimateTokens(JSON.stringify(msgs))
  let trimmed = 0
  for (let i = 1; i < msgs.length && tokens > maxTokens; ) {
    msgs.splice(i, 1)
    trimmed++
    tokens = estimateTokens(JSON.stringify(msgs))
  }
  if (tokens > maxTokens && msgs.length > 0) {
    // Last resort: truncate the system prompt (keeps the newest user turn).
    const keepChars = Math.max(500, Math.floor((maxTokens / Math.max(tokens, 1)) * (msgs[0].content.length || 0)))
    msgs[0].content = msgs[0].content.slice(0, keepChars)
  }
  return trimmed
}

export function selectProjectionInputs(
  routeResult: Awaited<ReturnType<typeof router>>,
  ctx: Awaited<ReturnType<typeof getUserContext>>,
  patientHash?: string | null,
  sessionId?: string,
) {
  switch (routeResult.intent) {
    case 'sql':
      // Factual queries: rely on SQL-retrieved patient/study context; skip accumulated memory
      return { facts: [], episodes: [], skills: [] }
    case 'vector':
      // Knowledge questions: keep facts/knowledge, skip episodic chat history
      return { facts: isolateFactsByScope(ctx.facts.all(), patientHash).slice(0, 50), episodes: [], skills: [] }
    case 'file':
      // File queries: context comes from attachments; skip accumulated memory
      return { facts: [], episodes: [], skills: [] }
    case 'mixed':
    default:
      // Ambiguous or summary questions: keep full context (patient-isolated);
      // episodes are limited to the current session's un-reviewed summary.
      return {
        facts: isolateFactsByScope(ctx.facts.all(), patientHash).slice(0, 50),
        episodes: sessionId ? ctx.episodes.all().filter((e) => e.sessionId === sessionId) : [],
        skills: ctx.skills.all(),
      }
  }
}

/**
 * Patient isolation for the facts layer (BRAIN2_MEMORY_LIFECYCLE §4.2):
 * in a patient-scoped chat only that patient's facts are injected in full;
 * cross-patient facts appear only when importance >= 4 (limited, tagged).
 */
function isolateFactsByScope(allFacts: any[], patientHash?: string | null): any[] {
  if (!patientHash) return allFacts
  const own = allFacts.filter((f) => f.patientHash === patientHash)
  const cross = allFacts
    .filter((f) => f.patientHash && f.patientHash !== patientHash && (f.importance ?? 3) >= 4)
    .slice(0, 5)
    .map((f) => ({
      ...f,
      content: `[patient: ${f.patientHash}] ${f.content}`,
    }))
  return [...own, ...cross]
}
