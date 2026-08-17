/**
 * #303/#437: /agent/chat handler — owns the turn pipeline. SSE transport
 * lives in chat-sse.js; the router only registers routes.
 *
 * #437: shared helpers (budget / projection / command formatting / attachments)
 * moved to chat-context.ts; the turn is split into testable pipeline stages:
 *   streamUnshownCompaction → routeQuery → handleDirectIntents →
 *   buildChatContext → runToolCallLoop → streamFinalResponse
 */
import type { FastifyRequest, FastifyReply } from 'fastify'
import type { EvolutionQueue } from '../evolution/evolution.queue.js'
import { createSseSender } from './chat-sse.js'
import { makeLogger } from '../../common/logger.js'
import prisma from '../../common/prisma'
import { getUserContext, buildCachedPersona, buildFileContext } from './user-context.js'
import type { ChatScene } from '../../common/persona.js'
import { deepseekStream, deepseekChat, deepseekChatWithMeta, LlmTruncatedError, getApiKey, DEEPSEEK_PREMIUM_MODEL } from '../../common/llm.js'
import { chatSendSchema } from './chat.dto.js'
import { analyzeChatForPatient, updatePatientFromFindings, analyzeChatForMedicalRecord, updateMedicalRecordFromChat } from '../patients/clinical-analysis.js'
import { router } from '../../retrieval/query-router.js'
import { resolveSidecarIntent, type SidecarDecisionDetail } from '../../retrieval/intent-router.js'
import { buildHistoryMessages } from '../../retrieval/context-compressor.js'
import { detectDoomLoop } from '../../tools/doom-loop.js'
import { ensureSessionCompaction, getInFlightCompaction } from '../../memory/compaction/index.js'
import { handleKnowledgeCommand } from '../knowledge/knowledge-command-handler.js'
import { handlePluginChatRequest } from '../plugins/plugin-chat-handler.js'
import { PrismaKnowledgeGapService } from '../knowledge/knowledge-gap.service.js'
import { PrismaTelemetryService } from '../knowledge/telemetry.service.js'
import { ToolRegistry, type ToolContext } from '../../tools/tool-registry.js'
import type { ToolDefinition } from '../../tools/base-tool.js'
import {
  formatCommandResult,
  enforceTotalBudget,
  selectProjectionInputs,
  resolveScene,
  buildAttachmentParts,
} from './chat-context.js'
import { providerSupportsVision, type ChatContentPart } from '../../common/llm-gateway.js'

const gapService = new PrismaKnowledgeGapService()
/** #6: per-patient LLM analysis throttle (ms) — avoid an extra call per message. */
const chatAnalysisThrottle = new Map<string, number>()
const telemetry = new PrismaTelemetryService()
const log = makeLogger('chat.router')

interface TurnIO {
  send: (chunk: any) => void
  signal: AbortSignal
}

/**
 * R2: stream a not-yet-shown compaction summary into the conversation.
 * A compaction evolution event that landed AFTER the last reply is
 * 'unshown' — push its Session Memory summary as a streamed message.
 */
async function streamUnshownCompaction(ctx: Awaited<ReturnType<typeof getUserContext>>, sid: string, io: TurnIO): Promise<void> {
  try {
    const allEvents = ctx.eventLog.query({ sessionId: sid })
    const lastReply = allEvents
      .filter((e: any) => e.eventType === 'assistant_response')
      .sort((a: any, b: any) => b.idx - a.idx)[0]
    const lastCompaction = allEvents
      .filter((e: any) => e.eventType === 'evolution' && String(e.content || '').includes('自动压缩'))
      .sort((a: any, b: any) => b.idx - a.idx)[0]
    if (lastCompaction && (!lastReply || lastCompaction.idx > lastReply.idx)) {
      const sessionMemory = ctx.episodes.all().find((e: any) => e.sessionId === sid)
      const summaryText = sessionMemory?.summary || ''
      if (summaryText) {
        const header = `🧠 会话历史已压缩，上下文预算已恢复\n\n${summaryText}`
        for (const piece of header.match(/.{1,60}/gs) || []) {
          io.send({ type: 'compaction_chunk', text: piece })
        }
        io.send({ type: 'compaction_completed' })
      }
    }
  } catch {
    // compaction summary streaming is best-effort
  }
}

/** Build conversation history (newest-first) under a token/turn budget. */
async function loadHistoryBudget(
  ctx: Awaited<ReturnType<typeof getUserContext>>,
  sid: string,
  userId: string,
): Promise<{
  history: any[]
  historyMessages: Array<{ role: 'user' | 'assistant'; content: string }>
  omittedTurns: number
  historyTokens: number
  maxHistoryTokens: number
  historyTurns: number
  compactedUpto: number
}> {
  const maxHistoryTokens = parseInt(process.env.MAX_HISTORY_TOKENS || '8000', 10)
  const historyTurns = parseInt(process.env.HISTORY_TURNS || '20', 10)
  let compactedUpto = 0
  try {
    const lastCompaction = await (prisma as any).kbCompaction.findFirst({
      where: { userId, sessionId: sid },
      orderBy: { coveredUptoIdx: 'desc' },
    })
    compactedUpto = lastCompaction?.coveredUptoIdx ?? 0
  } catch {
    // kbCompaction may not exist yet
  }
  // Only user/assistant messages count as turns — tool calls, tool results
  // and context events are transport noise and must NOT trigger compaction
  // (#compaction-fix: a 3-turn chat with heavy tool use filled the 40-event
  // window and compacted repeatedly while the token budget was nearly empty).
  const history = ctx.eventLog
    .query({ sessionId: sid, limit: historyTurns * 2 * 8 })
    .filter((e: any) => e.idx > compactedUpto && (e.eventType === 'user_message' || e.eventType === 'assistant_response'))
    .reverse()
  const { messages: historyMessages, omittedTurns, tokens: historyTokens } = buildHistoryMessages(history, {
    maxTokens: maxHistoryTokens,
    maxTurns: historyTurns,
  })
  return { history, historyMessages, omittedTurns, historyTokens, maxHistoryTokens, historyTurns, compactedUpto }
}

/** Load the session's latest compaction boundary (for the sidecar/plugin path). */
async function loadCompactedUpto(userId: string, sid: string): Promise<number> {
  try {
    const compacted = await (prisma as any).kbCompaction.findFirst({
      where: { userId, sessionId: sid },
      orderBy: { coveredUptoIdx: 'desc' },
    })
    return compacted?.coveredUptoIdx ?? 0
  } catch {
    return 0
  }
}

/** Fetch the patient record (or null) for the chat scope. */
async function findPatient(userId: string, patientHash?: string | null): Promise<any | null> {
  if (!patientHash) return null
  return (prisma as any).patientRecord.findFirst({ where: { hash: patientHash, userId } })
}

/**
 * Tool-calling loop: up to MAX_TOOL_ROUNDS rounds of <tool_call> execution.
 * Owns the tool state machine (pending→running→completed/error), doom-loop
 * detection, sub-agent SSE surfacing and per-tool media events.
 */
async function runToolCallLoop(params: {
  currentMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ChatContentPart[] }>
  toolRegistry: ToolRegistry
  tools: ToolDefinition[]
  apiKey: string
  io: TurnIO
  ctx: Awaited<ReturnType<typeof getUserContext>>
  userId: string
  sessionId: string
}): Promise<{ finalContent: string; messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ChatContentPart[] }> }> {
  const { currentMessages, toolRegistry, tools, io, ctx, userId, sessionId } = params

  // R3 — tool-call persistence: per-session sequence numbers continue
  // across turns (and process restarts) by deriving from the log.
  const existingToolEvents = ctx.eventLog.query({ sessionId }).filter((e: any) => e.eventType === 'tool_call')
  let toolSeq = existingToolEvents.length
  const doomHistory: Array<{ tool: string; argsKey: string }> = []

  const appendToolEvent = (eventType: string, content: string, metadata: Record<string, unknown>) => {
    ctx.eventLog.append({
      timestamp: Date.now() / 1000,
      eventType,
      content,
      metadata,
      agentId: userId,
      sessionId,
    })
  }

  let messages = [...currentMessages]
  const MAX_TOOL_ROUNDS = 5
  let toolRound = 0
  let finalContent = ''

  while (toolRound < MAX_TOOL_ROUNDS) {
    toolRound++
    // #548: use chatWithMeta (truncation-aware) and the gateway default token
    // budget (MAX_OUTPUT_TOKENS, 8192) instead of a hardcoded 4096.
    const call = await deepseekChatWithMeta(
      messages,
      params.apiKey,
      {
        model: DEEPSEEK_PREMIUM_MODEL,
        telemetryContext: { userId, workspaceId: userId, action: 'chat.main' },
        signal: io.signal,
      },
      tools,
      (reasoning) => io.send({ type: 'reasoning_chunk', text: reasoning }),
    )
    const callResult = call.text

    if (!callResult) {
      finalContent = ''
      break
    }

    // Parse JSON response — DeepSeek returns plain text; check for function calls in the text.
    // Match all <tool_call> blocks (each may contain nested JSON in `arguments`).
    const toolCallBlocks = callResult.match(/<tool_call>([\s\S]*?)<\/tool_call>/g)
    // #548: the final answer hit the output token budget — tell the user the
    // reply was cut off instead of silently presenting a half answer. An
    // empty callResult means the reasoning burned the budget (the gateway
    // auto-retried already) — explain, don't leave a blank turn.
    if (call.truncated && (!toolCallBlocks || toolCallBlocks.length === 0)) {
      io.send({
        type: 'truncated',
        message: callResult.trim()
          ? '回答因输出长度限制被截断，请重试或简化问题'
          : '回答在思考阶段被输出限制中断，未能生成内容，请重试或简化问题',
      })
    }
    if (toolCallBlocks && toolCallBlocks.length > 0) {
      let executedAny = false
      let toolError: string | null = null
      // The assistant message must appear ONCE regardless of how many
      // tool calls it contains — re-pushing it per block would duplicate
      // the whole payload N times and corrupt the turn history.
      messages.push({ role: 'assistant', content: callResult })
      for (const block of toolCallBlocks) {
        let toolCall: any = null
        try {
          toolCall = JSON.parse(block.replace(/<\/?tool_call>/g, '').trim())
        } catch (err) {
          // §3.3: malformed JSON must not crash the turn — tell the model
          // to re-emit a valid call instead of dying silently.
          appendToolEvent('tool_call', 'malformed_arguments', {
            tool: '?', args: 'parse-failed', status: 'error', seq: ++toolSeq,
          })
          messages.push({ role: 'assistant', content: block })
          messages.push({
            role: 'user',
            content: 'The previous tool call had malformed JSON arguments. Please re-emit the tool call with valid JSON only.',
          })
          continue
        }
        const toolName = toolCall.name || toolCall.tool
        const toolArgs = toolCall.arguments || toolCall.args || {}
        executedAny = true

        toolSeq++
        const seq = toolSeq
        const argsPreview = String(JSON.stringify(toolArgs) || '').slice(0, 300)

        // R3: persist the state machine — pending → running → completed/error.
        appendToolEvent('tool_call', `${toolName}(${argsPreview})`, {
          tool: toolName, args: argsPreview, status: 'pending', seq,
        })

        // Doom-loop guard: same tool + identical args 3x consecutively.
        if (detectDoomLoop(doomHistory, toolName, toolArgs)) {
          log.warn('doom-loop detected', { tool: toolName, seq })
          appendToolEvent('tool_call', `${toolName}(${argsPreview})`, {
            tool: toolName, args: argsPreview, status: 'warning', seq,
          })
        }

        io.send({ type: 'tool_call', tool: toolName, args: toolArgs })

        appendToolEvent('tool_call', `${toolName}(${argsPreview})`, {
          tool: toolName, args: argsPreview, status: 'running', seq,
        })

        // #350: delegate = sub-agent activity — surface started/done
        // over SSE so the UI can show parallel research progress.
        const isSubagent = toolName === 'delegate' || toolName === 'spawn_subagent'
        const subTask = isSubagent ? String((toolArgs as any)?.task || argsPreview) : ''
        if (isSubagent) {
          const scope = String((toolArgs as any)?.scope || 'global')
          io.send({ type: 'subagent_started', task: subTask.slice(0, 200), scope })
        }

        const result = await toolRegistry.execute(toolName, toolArgs)

        // #419: generated images render in the chat stream.
        if (toolName === 'generate_image' && result.success && result.output) {
          try {
            const parsed = JSON.parse(result.output)
            if (parsed.url) {
              io.send({ type: 'image_attached', url: parsed.url, caption: parsed.prompt?.slice(0, 120) })
            }
          } catch { /* non-JSON */ }
        }

        // #418: surface memory-search hits to the doctor (AI 依据可见).
        if (toolName === 'search_node' && result.success && result.output) {
          try {
            const parsed = JSON.parse(result.output)
            const hits = Array.isArray(parsed?.hits) ? parsed.hits : []
            if (hits.length > 0) {
              io.send({
                type: 'memory_hits',
                count: hits.length,
                hits: hits.slice(0, 10).map((h: any) => ({
                  content: String(h.content || '').slice(0, 200),
                  type: String(h.node_type || 'fact'),
                  id: String(h.node_id || ''),
                })),
              })
            }
          } catch { /* non-JSON output */ }
        }

        if (isSubagent) {
          let cost = 0
          if (result.success && result.output) {
            try { cost = Number(JSON.parse(result.output).cost_tokens) || 0 } catch { /* ignore */ }
          }
          io.send({ type: 'subagent_done', task: subTask.slice(0, 200), success: result.success, cost_tokens: cost })
        }

        messages.push({
          role: 'user',
          content: `Tool "${toolName}" returned: ${result.success ? (result.output || 'Success') : `Error: ${result.error}`}`,
        })

        if (result.success) {
          const output = result.output || ''
          appendToolEvent('tool_call', `${toolName}(${argsPreview})`, {
            tool: toolName, args: argsPreview, status: 'completed', seq,
          })
          appendToolEvent('tool_result', output.slice(0, 500), {
            toolCallId: seq, success: true, outputTruncated: output.length > 500,
          })
          // §15.4: surface document write-backs to the writing canvas.
          if (toolName === 'edit_document') {
            try {
              const parsed = JSON.parse(output) as { body?: string; summary?: string }
              if (typeof parsed.body === 'string') {
                io.send({ type: 'doc_updated', body: parsed.body, summary: parsed.summary || '' })
              }
            } catch {
              // non-JSON output — nothing to surface
            }
          }
          // #176: surface generated charts as images in the message.
          if (toolName === 'render_chart') {
            try {
              const parsed = JSON.parse(output) as { url?: string; markdown?: string; type?: string }
              if (parsed.url) {
                io.send({ type: 'chart_created', url: parsed.url, markdown: parsed.markdown || '', chart_type: parsed.type || '' })
              }
            } catch {
              // non-JSON output — nothing to surface
            }
          }
        } else {
          appendToolEvent('tool_call', `${toolName}(${argsPreview})`, {
            tool: toolName, args: argsPreview, status: 'error', seq,
          })
          appendToolEvent('tool_result', (result.error || '').slice(0, 500), {
            toolCallId: seq, success: false, error: (result.error || '').slice(0, 200),
          })
          toolError = result.error ?? 'Unknown tool error'
          break
        }
      }
      if (executedAny) {
        if (toolError) {
          finalContent = `I tried to use a tool but encountered an error: ${toolError}`
          break
        }
        continue
      }
    }

    // §3.3: never surface raw <tool_call> markers to the user — strip
    // any unparsed blocks before sending the final answer.
    const cleaned = (callResult || '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim()
    finalContent = cleaned || 'I was unable to complete that request. Please try again.'
    break
  }

  return { finalContent, messages }
}

export interface ChatRouterOptions {
  evolutionQueue?: EvolutionQueue
}
export async function handleAgentChat(request: FastifyRequest, reply: FastifyReply, opts: { evolutionQueue?: EvolutionQueue } = {}): Promise<void> {
    // #349: zod-validated body — bad input is rejected at the entry.
    const parsed = chatSendSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: `Invalid request: ${parsed.error.issues[0]?.message || 'validation failed'}` })
    }
    const body = parsed.data

    const userId = request.user!.userId
    const ctx = getUserContext(userId)
    const sid = body.session_id || `session_${Math.random().toString(36).slice(2, 10)}`
    const patientHash = body.patient_hash || null
    // #510/#546: scene 解析与一致性修正(显式 patient 无 patient_hash 等
    // 错配会降级 general) — 单点实现 resolveScene(chat-context.ts)。
    const scene: ChatScene = resolveScene({
      explicit: body.scene,
      patientHash,
      sessionId: sid,
    })
    const apiKey = getApiKey()

    // #303: SSE transport extracted — owns headers, disconnect abort, close.
    const { send, signal: chatAbortSignal, end: sseEnd } = createSseSender(reply)
    const chatAbort = new AbortController()
    chatAbortSignal.addEventListener('abort', () => { try { chatAbort.abort() } catch { /* ignore */ } })
    const io: TurnIO = { send, signal: chatAbort.signal }

    try {
      // #185: persist the user message BEFORE any LLM work — a mid-stream
      // failure must never lose the turn from the event log.
      ctx.eventLog.append({
        timestamp: Date.now() / 1000, eventType: 'user_message', content: body.text,
        metadata: { patientHash }, agentId: userId, sessionId: sid,
      })
      send({ type: 'turn_started', event_idx: ctx.eventLog.count() + 1, patient_hash: patientHash })

      // ── P3: Route the query before building expensive context ──
      // #557: rule layer only — the LLM fallback classifier was retired here.
      // sidecar generation is adjudicated once by resolveSidecarIntent below
      // (its SINGLE authority); rule-missed queries flow into the normal
      // conversation pipeline instead of paying a second LLM call.
      const routeResult = await router(body.text, {})
      await telemetry.record({
        userId,
        workspaceId: userId,
        category: 'router',
        action: routeResult.intent,
        metadata: {
          ruleHit: routeResult.ruleHit,
          llmFallback: routeResult.llmFallback,
          llmCalls: routeResult.cost.llmCalls,
        },
      }).catch(() => {})
      send({ type: 'context_info', text: `Router: ${routeResult.intent} (ruleHit=${routeResult.ruleHit}, llmFallback=${routeResult.llmFallback})`, kind: 'router' })

      await streamUnshownCompaction(ctx, sid, io)

      // Knowledge commands are handled directly without calling the chat LLM
      if (routeResult.intent === 'knowledge_command') {
        const kbResult = await handleKnowledgeCommand({
          workspaceId: userId,
          userId,
          factsStore: ctx.facts,
          knowledgeStore: ctx.knowledge,
          gapService,
        }, body.text)
        const response = formatCommandResult(kbResult)

        await telemetry.record({
          userId,
          workspaceId: userId,
          category: 'kb_command',
          action: kbResult.type === 'error' ? 'error' : kbResult.type.replace(/^kb_/, ''),
          metadata: {
            commandType: kbResult.type,
            hadError: kbResult.type === 'error',
          },
        }).catch(() => {})

        ctx.eventLog.append({
          timestamp: Date.now() / 1000, eventType: 'user_message', content: body.text,
          metadata: { patientHash, kbCommand: true }, agentId: userId, sessionId: sid,
        })
        ctx.eventLog.append({
          timestamp: Date.now() / 1000, eventType: 'assistant_response', content: response,
          metadata: { kbCommand: true, commandType: kbResult.type }, agentId: userId, sessionId: sid,
        })

        send({ type: 'final_answer_chunk', text: response })
        send({ type: 'citations', items: [] })
        send({ type: 'turn_complete', assistant_event_idx: ctx.eventLog.count() })
        return
      }

      // Plugin-based document rendering — handled directly without streaming
      // LLM output. #452/#549: the main router no longer classifies sidecar
      // (its LLM fallback lacked the edit/polish exclusion and caused
      // #552-class misroutes); resolveSidecarIntent is the SINGLE authority
      // for "is this a file-generation request" — rule candidate recall →
      // LLM adjudicator → conservative fallback, all with history context.
      const recentTurns = ctx.eventLog.query({ sessionId: sid, limit: 40 })
        .reverse()
        .filter((evt: any) => evt.eventType === 'user_message' || evt.eventType === 'assistant_response')
        .slice(0, 6)
        .map((evt: any) => ({
          role: evt.eventType === 'user_message' ? ('user' as const) : ('assistant' as const),
          content: evt.content,
        }))
      // #560/#561: capture the adjudication detail — telemetry-worthy verdict
      // distribution and, on 'uncertain', an intent_clarify hint for the UI
      // (the request could be a generation request, but the LLM was unsure).
      let sidecarDetail: SidecarDecisionDetail | undefined
      const isSidecarRequest = await resolveSidecarIntent(userId, body.text, {
        history: recentTurns,
        onDecision: (detail) => { sidecarDetail = detail },
      })
      await telemetry.record({
        userId,
        workspaceId: userId,
        category: 'sidecar',
        action: 'intent',
        metadata: {
          verdict: sidecarDetail?.verdict ?? 'uncertain',
          vetoed: sidecarDetail?.vetoed ?? false,
          llmCalls: sidecarDetail?.llmCalls ?? 0,
          cacheHit: sidecarDetail?.cacheHit ?? false,
          textLength: sidecarDetail?.textLength ?? body.text.length,
          historyTurns: sidecarDetail?.historyTurns ?? 0,
        },
      }).catch(() => {})
      if (!isSidecarRequest && sidecarDetail?.verdict === 'uncertain') {
        // #561: conservative by design — never generate on doubt, but tell
        // the user we can generate if they confirm.
        send({
          type: 'intent_clarify',
          text: '如果你是想让我生成一份文档/PPT/表格，请明确说"生成/导出"；否则我会按普通对话回复。',
        })
      }
      if (isSidecarRequest) {
        const patient = await findPatient(userId, patientHash)

        // Conversation history from event log (same source as the normal
        // chat path; compacted segments are replaced by the Session Memory).
        const compactedUpto = await loadCompactedUpto(userId, sid)
        const history = ctx.eventLog.query({ sessionId: sid, limit: 40 })
          .reverse()
          .filter((evt: any) => evt.idx > compactedUpto && (evt.eventType === 'user_message' || evt.eventType === 'assistant_response'))
          .map((evt: any) => ({
            role: evt.eventType === 'assistant_response' ? ('assistant' as const) : ('user' as const),
            content: evt.content,
          }))

        const pluginResult = await handlePluginChatRequest({
          userId,
          workspaceId: userId,
          text: body.text,
          patient: patient
            ? {
                initials: patient.initials,
                age: patient.age,
                sex: patient.sex,
                diagnosis: patient.diagnosis,
                chiefComplaint: patient.chiefComplaint,
              }
            : null,
          history,
          telemetryContext: { userId, workspaceId: userId, action: 'plugin.build_payload' },
          send,
        })

        // #558: the request was editing/polishing existing content that only
        // looked like a generation request — fall back to the normal
        // conversation pipeline (no plugin telemetry/events, no early return).
        if (pluginResult.fallback) {
          send({ type: 'context_info', text: '未匹配到生成意图，转入常规对话。', kind: 'plugin' })
        } else {
          await telemetry.record({
            userId,
            workspaceId: userId,
            category: 'plugin',
            action: 'render',
            metadata: {
              jobId: pluginResult.job?.job_id,
              status: pluginResult.job?.status,
              hadError: pluginResult.job?.status === 'failed',
            },
          }).catch(() => {})

          ctx.eventLog.append({
            timestamp: Date.now() / 1000,
            eventType: 'user_message',
            content: body.text,
            metadata: { patientHash, plugin: true },
            agentId: userId,
            sessionId: sid,
          })
          const pluginMeta: Record<string, unknown> = { plugin: true, sidecar: true, jobId: pluginResult.job?.job_id }
          if (pluginResult.file) {
            pluginMeta.file = {
              fileId: pluginResult.file.fileId,
              fileName: pluginResult.file.fileName,
              mimeType: pluginResult.file.mimeType,
            }
            pluginMeta.knowledgePayload = {
              title: pluginResult.file.fileName,
              content: pluginResult.text || `Generated document: ${pluginResult.file.fileName}`,
            }
          }
          ctx.eventLog.append({
            timestamp: Date.now() / 1000,
            eventType: 'assistant_response',
            content: pluginResult.text,
            metadata: pluginMeta,
            agentId: userId,
            sessionId: sid,
          })

          send({ type: 'final_answer_chunk', text: pluginResult.text })
          if (pluginResult.file) {
            send({
              type: 'sidecar_file',
              file_id: pluginResult.file.fileId,
              file_name: pluginResult.file.fileName,
              mime_type: pluginResult.file.mimeType,
              download_url: pluginResult.file.downloadUrl,
              expires_in: pluginResult.file.expiresIn,
              knowledge_payload: {
                title: pluginResult.file.fileName,
                content: pluginResult.text || `Generated document: ${pluginResult.file.fileName}`,
              },
            })
          }
          send({ type: 'citations', items: [] })
          send({ type: 'turn_complete', assistant_event_idx: ctx.eventLog.count() })
          return
        }
      }

      // #2/#544: 附件 → 对话内容(图片多模态/超限降级/文本注入)由
      // buildAttachmentParts 纯函数处理;事件说明在此发送。
      const { parts: userParts, attachmentText, notes: attachmentNotes } = await buildAttachmentParts(body.attachments, {
        userId,
        vision: providerSupportsVision(),
      })
      for (const note of attachmentNotes) {
        send({ type: 'context_info', text: note, kind: 'attachment' })
      }

      let fullMessage = attachmentText ? `${attachmentText}\n\nUser query: ${body.text}` : body.text

      // Inject patient demographics + memory findings into chat context
      if (patientHash) {
        const patient = await findPatient(userId, patientHash)
        const parts: string[] = ['## Current Patient Context']
        if (patient) {
          if (patient.initials) parts.push(`- Name: ${patient.initials}`)
          if (patient.age) parts.push(`- Age: ${patient.age}`)
          if (patient.sex) parts.push(`- Sex: ${patient.sex}`)
          if (patient.chiefComplaint) parts.push(`- Chief Complaint: ${patient.chiefComplaint}`)
        }
        // Inject memory facts for this patient as structured findings
        const patientFacts = ctx.memory.graph.getCurrentNodesByType('fact')
          .filter((n: any) => (n as any).patientHash === patientHash)
          .slice(0, 20)
        if (patientFacts.length > 0) {
          parts.push('- Clinical Findings:')
          for (const f of patientFacts) {
            const cat = (f as any).category || 'fact'
            const content = (f as any).content || ''
            const imp = (f as any).importance || 3
            if (content) parts.push(`  * [${cat}] ${content} (importance: ${imp}/5)`)
          }
        }
        if (parts.length > 1) {
          send({ type: 'context_info', text: parts.join('\n'), kind: 'patient_context' })
          fullMessage = parts.join('\n') + '\n\n' + fullMessage
        }
      }

      // Always include patient roster so AI knows the user's patient list
      const allPatients = await (prisma as any).patientRecord.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      })
      if (allPatients.length > 0) {
        const roster = allPatients.map((p: any) => {
          const parts = [`- ${p.initials || 'Unknown'}`]
          if (p.age) parts.push(`${p.age}y/o`)
          if (p.sex) parts.push(p.sex)
          if (p.chiefComplaint) parts.push(`CC: ${p.chiefComplaint}`)
          return parts.join(', ')
        }).join('\n')
        send({ type: 'context_info', text: `## Patient Roster (${allPatients.length} patients)\n${roster}`, kind: 'patient_roster' })
        fullMessage = `## Patient Roster (${allPatients.length} patients)\n${roster}\n\n` + fullMessage
      } else {
        fullMessage = '## Patient Roster\nNo patients registered yet.\n\n' + fullMessage
      }

      // Deterministic handler for "list my patients" to avoid LLM hallucination
      const isListPatientsQuery = /list\s+all\s+my\s+patients|my\s+patients\s+by\s+initials|列出所有患者|列出我的患者/i.test(body.text)
      if (!patientHash && isListPatientsQuery && allPatients.length > 0) {
        const response = allPatients
          .map((p: any) => {
            const diagnosis = p.chiefComplaint?.trim() || 'no recorded diagnosis'
            return `- ${p.initials || 'Unknown'}: ${diagnosis.split('\n')[0].slice(0, 120)}`
          })
          .join('\n')

        // user_message was persisted upfront (#185); only log the reply.
        ctx.eventLog.append({
          timestamp: Date.now() / 1000, eventType: 'assistant_response', content: response,
          metadata: {}, agentId: userId, sessionId: sid,
        })

        send({ type: 'reasoning_chunk', text: 'Using patient roster directly.' })
        send({ type: 'final_answer_chunk', text: response })
        send({ type: 'citations', items: [] })
        send({ type: 'turn_complete', assistant_event_idx: ctx.eventLog.count() })

        // Writing sessions (doc-*) are event-log namespaces, not user-facing
        // sessions — never create a Session row for them.
        if (!sid.startsWith('doc-')) {
          await prisma.session.upsert({
            where: { id: sid },
            update: { lastMessageAt: new Date().toISOString(), messageCount: { increment: 1 } },
            create: { id: sid, userId, title: body.text.slice(0, 50), createdAt: new Date().toISOString() },
          })
        }
        return
      }

      // Inject recent file context for the patient
      if (patientHash) {
        try {
          const recentFiles = await (prisma as any).fileIndex.findMany({
            where: { userId, patientHash, deletedAt: null },
            orderBy: { createdAt: 'desc' },
            take: 5,
          })
          if (recentFiles.length > 0) {
            const fileCtx = buildFileContext(recentFiles)
            send({ type: 'context_info', text: fileCtx, kind: 'file_context' })
            fullMessage = fileCtx + '\n\n' + fullMessage
          }
        } catch {
          // FileIndex table may not exist yet
        }
      }

      // Build dynamic persona from user's accumulated knowledge (K5: cached
      // until facts/knowledge versions change). #510: persona variant follows
      // the entry scene so non-patient scenes stop inheriting the
      // patient-centric guidance.
      const persona = buildCachedPersona(userId, ctx.facts, ctx.knowledge, scene)

      // #2: Weighted attention context projection (filtered by router intent)
      const projectionInputs = selectProjectionInputs(routeResult, ctx, patientHash, sid)
      const projected = await ctx.orchestrator['projection'].project({
        userId, patientHash, sessionId: sid,
        persona,
        facts: projectionInputs.facts,
        episodes: projectionInputs.episodes,
        skills: projectionInputs.skills,
      })
      send({ type: 'context_info', text: projected.budget.map((b: any) => `${b.layer}: ${b.tokens}t/${b.items}i`).join(' | '), kind: 'projection' })

      // #5: Include research study context
      const studies = await (prisma as any).researchStudy.findMany({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
        take: 10,
      })
      let studyContext = ''
      if (studies.length > 0) {
        studyContext = '\n## Active Research Studies (ALWAYS use the short_code below to refer to a study when the user mentions it)\n'
        for (const s of studies) {
          studyContext += `- **${s.shortCode}**: ${s.name}\n`
          if (s.protocol) {
            studyContext += `  Protocol: ${s.protocol.slice(0, 700).replace(/\n/g, ' ')}\n`
          }
        }
        studyContext += '\nIMPORTANT: When the user asks about a specific study (e.g. "NSCLC001" or any short_code), you MUST reference that short_code in your reply. When asked about details not in the protocol snippet above, suggest importing the full protocol.\n'
      }

      // #5: Conversation history under a token budget; compaction replaces
      // the covered segment with the Session Memory summary.
      const {
        history,
        historyMessages,
        omittedTurns,
        historyTokens,
        maxHistoryTokens,
        historyTurns,
        compactedUpto,
      } = await loadHistoryBudget(ctx, sid, userId)
      // U3: surface the context budget usage so the user can anticipate the
      // next compaction (100% of the history budget or the turn window cap).
      send({
        type: 'context_usage',
        history_tokens: historyTokens,
        history_budget: maxHistoryTokens,
        history_turns: historyTurns,
        omitted_turns: omittedTurns,
        will_compact: omittedTurns > 0 || history.length >= historyTurns * 2,
      })
      // Writing sessions (doc-{docId}) inject the current document + its
      // references as the docs/current context source (§15.4).
      let docContext = ''
      if (sid.startsWith('doc-')) {
        try {
          const docId = sid.slice(4)
          const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
          if (doc) {
            const refs = await (prisma as any).docReference.findMany({
              where: { userId, docId },
              orderBy: { createdAt: 'asc' },
            })
            const refBlock = (refs || [])
              .map((r: any) => `### ${r.label || r.id}\n${String(r.snapshot || r.body || '').slice(0, 4000)}`)
              .join('\n\n')
            docContext = `\n\n## Current Document\n标题：${doc.title}\n\n${String(doc.body || '').slice(0, 12000)}\n\n## Reference Materials\n${refBlock || '(none)'}\n\n规则：用户在编辑这份文档。回答用中文；当用户要求修改文档时，调用 edit_document 工具写回完整的新文档内容（markdown）。`
          }
        } catch {
          // doc context is best-effort
        }
      }
      // R1 (#98): assemble the system prompt from typed context segments —
      // hash-snapshot per user so stable segments stay byte-identical
      // (provider prompt-cache friendly) and changes are diffable.
      let systemPrompt = projected.systemPrompt + studyContext + docContext
      try {
        const { computeSegments, saveSnapshot, loadSnapshot, renderSystemPrompt } = await import('../../memory/context-sources.js')
        const prev = loadSnapshot(userId)
        const segments: Array<{ key: string; text: string }> = [
          ...(projected.segments || []),
          ...(studyContext ? [{ key: 'study_context', text: studyContext }] : []),
          ...(docContext ? [{ key: 'document_context', text: docContext }] : []),
        ]
        const { state, diff } = computeSegments(userId, segments, prev)
        saveSnapshot(userId, state)
        if (diff.changed.length > 0 || diff.removed.length > 0) {
          log.info('context segments diffed', { changed: diff.changed, removed: diff.removed })
        }
        systemPrompt = renderSystemPrompt('', state)
      } catch {
        // snapshot/diff pipeline is best-effort — fall back to direct join
      }
      // #511: content may carry multimodal parts (images) on the user turn.
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ChatContentPart[] }> = [
        { role: 'system', content: systemPrompt },
      ]

      // R2 — anchored compaction with opencode-style delayed-sync semantics:
      // the triggering turn fires it async (no reply latency); any LATER turn
      // that arrives while it is still running awaits it before replying, so
      // the anchored summary is always injectable. Both cases surface a
      // compaction_started/compaction_completed event to the UI.
      const sendCompactionCompleted = async () => {
        const restored = ctx.eventLog
          .query({ sessionId: sid, limit: historyTurns * 2 * 8 })
          .filter((e: any) => e.idx > compactedUpto && (e.eventType === 'user_message' || e.eventType === 'assistant_response'))
          .reverse()
        const { tokens: restoredTokens } = buildHistoryMessages(restored, {
          maxTokens: maxHistoryTokens,
          maxTurns: historyTurns,
        })
        send({ type: 'compaction_completed', history_tokens: restoredTokens, history_budget: maxHistoryTokens, history_turns: historyTurns })
      }
      const inFlightCompaction = getInFlightCompaction(userId, sid)
      // Writing sessions (doc-*) are workspaces, not clinical dialogues —
      // their content must never leak into memory extraction.
      const isWritingSession = sid.startsWith('doc-')
      // #compaction-fix: trigger on REAL message turns (history is now
      // filtered to user/assistant), not raw event count.
      const shouldTrigger = !isWritingSession && (omittedTurns > 0 || history.length >= historyTurns * 2)
      if (shouldTrigger && historyMessages.length > 0) {
        const oldestRetainedIdx = (history[historyMessages.length - 1] as any)?.idx ?? 0
        send({ type: 'compaction_started' })
        ensureSessionCompaction(
          {
            userId,
            eventLog: ctx.eventLog,
            facts: ctx.facts,
            episodes: ctx.episodes,
            skills: ctx.skills,
            knowledge: ctx.knowledge,
            memory: ctx.memory,
          },
          sid,
          oldestRetainedIdx,
          patientHash || undefined,
        )
          .then(() => sendCompactionCompleted())
          .catch(() => {})
      } else if (inFlightCompaction) {
        // A compaction from an earlier turn is still running — wait for it
        // (and its anchored summary) before replying.
        send({ type: 'compaction_started' })
        await inFlightCompaction
        sendCompactionCompleted()
      }

      if (omittedTurns > 0) {
        messages.push({
          role: 'system',
          content: `[Note: ${omittedTurns} earlier turns of this conversation were omitted to stay within the context budget. Use the session summaries above for older context.]`,
        })
      }
      messages.push(...historyMessages)
      // #511: multimodal user message — image parts first, then the full
      // text (demographics/roster/file context stays inside the text part).
      messages.push({
        role: 'user' as const,
        content: userParts.length > 0 ? [...userParts, { type: 'text', text: fullMessage }] : fullMessage,
      })

      // §3.4 (#194): enforce a TOTAL token budget across all assembled
      // messages. History is trimmed oldest-first; the system prompt is
      // truncated as a last resort so a pathological projection can never
      // blow the context window.
      const maxTotalTokens = parseInt(process.env.MAX_TOTAL_TOKENS || '16000', 10)
      const trimmedTurns = enforceTotalBudget(messages, maxTotalTokens)
      if (trimmedTurns > 0) {
        send({
          type: 'context_info',
          text: `Context trimmed: ${trimmedTurns} earlier turns dropped to fit the total token budget.`,
          kind: 'projection',
        })
      }

      // Create tool registry for function calling
      const toolCtx: ToolContext = {
        userId,
        memory: ctx.memory,
        facts: ctx.facts,
        episodes: ctx.episodes,
        skills: ctx.skills,
        knowledge: ctx.knowledge,
        eventLog: ctx.eventLog,
        sessionId: sid,
      }
      const toolRegistry = new ToolRegistry(toolCtx)
      // #454-followup: plugin-gated renderers (render_chart / render_scene)
      // appear in the LLM tool list only while the owning plugin is
      // installed + enabled. #510: scene-scoped tool surface.
      const tools = await toolRegistry.getDefinitionsForUser(scene)

      // Tool-calling loop
      const { finalContent, messages: loopMessages } = await runToolCallLoop({
        currentMessages: messages,
        toolRegistry,
        tools,
        apiKey,
        io,
        ctx,
        userId,
        sessionId: sid,
      })

      // Stream the final response
      let fullResponse = ''
      if (finalContent) {
        const chunks = finalContent.match(/.{1,80}/g) || [finalContent]
        for (const chunk of chunks) {
          fullResponse += chunk
          send({ type: 'final_answer_chunk', text: chunk })
        }
      } else {
        // Fallback: use streaming for the response
        try {
          for await (const chunk of deepseekStream(loopMessages, apiKey, {
            model: DEEPSEEK_PREMIUM_MODEL,
            telemetryContext: { userId, workspaceId: userId, action: 'chat.main' },
            signal: chatAbort.signal,
          }, (reasoning) => send({ type: 'reasoning_chunk', text: reasoning }))) {
            fullResponse += chunk
            send({ type: 'final_answer_chunk', text: chunk })
          }
        } catch (err) {
          // #548: finish_reason='length' — keep the partial answer, but
          // surface a truncation notice instead of a hard error. A
          // zero-content truncation means the reasoning consumed the whole
          // budget (auto-retry already happened inside the gateway; if it
          // still failed the user must see the cause, not a silent blank).
          if (err instanceof LlmTruncatedError) {
            send({
              type: 'truncated',
              message: err.hadContent
                ? '回答因输出长度限制被截断，请重试或简化问题'
                : '回答在思考阶段被输出限制中断，未能生成内容，请重试或简化问题',
            })
          } else {
            throw err
          }
        }
      }

      // Log the assistant response (user_message was persisted upfront)
      ctx.eventLog.append({
        timestamp: Date.now() / 1000, eventType: 'assistant_response', content: fullResponse,
        metadata: {}, agentId: userId, sessionId: sid,
      })

      // #2: Extract takeaway + evolve facts + analyze patient chat (async evolution worker)
      // Writing sessions (doc-*) are excluded — their content must not
      // become global memory (leak into patient chats).
      if (opts.evolutionQueue && !sid.startsWith('doc-')) {
        opts.evolutionQueue.add({ userId, sessionId: sid, userMessage: body.text, patientHash: patientHash || undefined }).catch(() => {})
      }

      // #6: analyze patient turns (attachments AND plain text) into both
      // free findings (patient profile) and structured record sections.
      // Fire-and-forget; rate-limited to avoid an extra LLM call per
      // message (every ~15s max per patient, or when new files arrived).
      if (patientHash && (attachmentText || body.text.length >= 6)) {
        const analysisText = attachmentText
          ? `[FILE CONTENT]\n${attachmentText}\n[CHAT]\nUser: ${body.text}\nAI: ${fullResponse}`
          : `[CHAT]\nUser: ${body.text}\nAI: ${fullResponse}`
        const lastRun = chatAnalysisThrottle.get(`${userId}:${patientHash}`) ?? 0
        const now = Date.now()
        if (now - lastRun >= 15000) {
          chatAnalysisThrottle.set(`${userId}:${patientHash}`, now)
          if (chatAnalysisThrottle.size > 5000) chatAnalysisThrottle.clear()
          analyzeChatForMedicalRecord(userId, patientHash, analysisText, {
            userId,
            workspaceId: userId,
            action: 'clinical.analysis',
          })
            .then(async ({ findings, sections }) => {
              if (findings.length > 0) {
                await updatePatientFromFindings(userId, patientHash, findings)
              }
              if (Object.keys(sections).length > 0) {
                await updateMedicalRecordFromChat(userId, patientHash, sections)
              }
            })
            .catch(() => {})
        }
      }

      // Update session (writing doc-* sessions never get a Session row;
      // legacy global-* default sessions must never be recreated).
      if (!sid.startsWith('doc-') && !sid.startsWith('global-')) {
        await prisma.session.upsert({
          where: { id: sid },
          update: { lastMessageAt: new Date().toISOString(), messageCount: { increment: 1 } },
          create: { id: sid, userId, title: body.text.slice(0, 50), createdAt: new Date().toISOString() },
        })
      }

      send({ type: 'citations', items: [] })
      // #298: suggest saving a reusable procedure as a skill.
      try {
        const { looksLikeProcedure } = await import('../skills/skill-capture.service.js')
        if (looksLikeProcedure(fullResponse) && !sid.startsWith('doc-')) {
          send({ type: 'skill_capture_suggest', text: '这个流程我帮你整理成了技能，下次可以直接调用。要保存吗？' })
        }
      } catch { /* best-effort */ }
      send({ type: 'turn_complete', assistant_event_idx: ctx.eventLog.count() })
    } catch (err: any) {
      send({ type: 'error', message: err.message || 'Chat failed' })
    } finally {
      sseEnd()
    }
}
