/**
 * #303/#437: /agent/chat handler — turn DISPATCHER. SSE transport lives in
 * chat-sse.js; the router only registers routes.
 *
 * #544: the pipeline is split into testable stages:
 *   tool-loop.ts       — tool-calling loop (state machine, doom-loop, media)
 *   compaction.ts      — compaction scheduling + history budget
 *   conversation-turn.ts — normal conversation path (context → stream → persist)
 *   turn-intent.ts     — TurnIntent model + decision table
 * This file keeps: SSE lifecycle, routing (kb-command / sidecar+plugin /
 * normal conversation) and the adjudication telemetry.
 */
import type { FastifyRequest, FastifyReply } from 'fastify'
import type { EvolutionQueue } from '../evolution/evolution.queue.js'
import { createSseSender } from './chat-sse.js'
import type { ChatEvent } from './chat-events.js'
import { getUserContext } from './user-context.js'
import type { ChatScene } from '../../common/persona.js'
import { getApiKey } from '../../common/llm.js'
import { chatSendSchema } from './chat.dto.js'
import { router, EDIT_MARKERS } from '../../retrieval/query-router.js'
import { resolveSidecarIntent, type SidecarDecisionDetail } from '../../retrieval/intent-router.js'
import { handleKnowledgeCommand } from '../knowledge/knowledge-command-handler.js'
import { handlePluginChatRequest } from '../plugins/plugin-chat-handler.js'
import { PrismaKnowledgeGapService } from '../knowledge/knowledge-gap.service.js'
import { PrismaTelemetryService } from '../knowledge/telemetry.service.js'
import { formatCommandResult, resolveScene } from './chat-context.js'
import { resolveTargetCandidates, pickTarget, isGenerateRequest, recordTurnIntent, type TurnAction, type TurnIntent, type TurnSource, type TurnTarget } from './turn-intent.js'
import { runConversationTurn, findPatient } from './conversation-turn.js'
import { ensureSessionCompaction } from '../../memory/compaction/index.js'
import { streamUnshownCompaction, loadCompactedUpto } from './compaction.js'
import type { TurnIO } from './tool-loop.js'

/** 仅编辑语义判断（供决策表消歧——判定为编辑但存在多目标时需要澄清）。 */
function turnAction2edit(detail: SidecarDecisionDetail | undefined, text: string): boolean {
  return Boolean(detail?.vetoed) && EDIT_MARKERS.test(text)
}

const gapService = new PrismaKnowledgeGapService()
const telemetry = new PrismaTelemetryService()

export interface ChatRouterOptions {
  evolutionQueue?: EvolutionQueue
}


// #657: provider context-overflow fallback — when the model rejects the
// request as exceeding its context window, force a compaction of the session
// segment and retry the turn ONCE (the anchored summary + fresh budget make
// the retry fit). Never loops: the retry is a single extra attempt.
const OVERFLOW_HINTS = [
  'context_length_exceeded',
  'maximum context length',
  'context window',
  'too many tokens',
  'request too large',
  'invalid_request_error',
]

export function isContextOverflowError(err: unknown): boolean {
  const msg = String((err as Error)?.message || err || '').toLowerCase()
  return OVERFLOW_HINTS.some((h) => msg.includes(h))
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
      await resolveSidecarIntent(userId, body.text, {
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
          // #585 — 语义层探测值 + 耗时入库,供分歧率/延迟月报 (shadow→on 门槛)。
          semantic: sidecarDetail?.semantic,
          semanticMs: sidecarDetail?.semanticMs,
        },
      }).catch(() => {})
      // #583 — 判定全量入事件日志（脱敏指纹），供审计重建与 #560 语料。
      // #578 — 用 TurnIntent（scene×action×target）驱动决策路由：generate 走插件，
      // edit/answer 回落常规对话；编辑目标冲突（附件 vs 当前草稿，例 C）要澄清。
      const candidates = resolveTargetCandidates(
        { scene, sessionId: sid, hasAttachment: Boolean(body.attachments?.length), patientHash },
      )
      const picked = pickTarget({ text: body.text, hasAttachment: Boolean(body.attachments?.length) }, candidates)
      const turnIntent: TurnIntent = {
        action: (sidecarDetail?.verdict === 'generate' ? 'generate'
          : (sidecarDetail?.vetoed ? (EDIT_MARKERS.test(body.text) ? 'edit' : 'answer') : 'answer')) as TurnAction,
        target: (sidecarDetail?.verdict === 'generate' ? 'none' : picked.target) as TurnTarget,
        source: (sidecarDetail?.semantic ? 'semantic' : 'llm') as TurnSource,
        confidence: sidecarDetail?.verdict === 'generate' ? 0.8 : 0.6,
        needsClarify: sidecarDetail?.verdict === 'uncertain' || (turnAction2edit(sidecarDetail, body.text) && picked.needsClarify),
        clarifyOptions: (sidecarDetail?.verdict === 'uncertain' || (turnAction2edit(sidecarDetail, body.text) && picked.needsClarify)
          ? picked.options
          : []),
        payload: {
          rawText: body.text,
          patientHash: patientHash ?? undefined,
          historyTurns: sidecarDetail?.historyTurns,
          editDocumentId: picked.target === 'current_doc' && sid.startsWith('doc-') ? sid.slice(4) : undefined,
        },
      }
      recordTurnIntent(ctx.eventLog, {
        userId, sessionId: sid, text: body.text, intent: turnIntent,
        llmCalls: sidecarDetail?.llmCalls ?? 0, vetoed: sidecarDetail?.vetoed ?? false, cacheHit: sidecarDetail?.cacheHit,
        semantic: sidecarDetail?.semantic,
      })
      // #598: 移除人工澄清 — 意图不确定(uncertain)时按普通对话处理,
      // 不再弹出'生成文档'反问;确定的生成请求由 isGenerateRequest 直接
      // 走插件管线,文档生成可逆,用户可用'生成一份…'随时触发。
      if (isGenerateRequest(turnIntent)) {
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
          // #637: 插件事件流独立于 ChatEvent(自有载荷),透传未知载荷。
          send: (d: unknown) => send(d as ChatEvent),
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

      // #544: 正常对话路径(上下文组装/工具循环/流式/持久化)已抽到
      // conversation-turn.ts — 本文件只保留调度。
      const turnParams = {
        userId,
        ctx,
        sid,
        patientHash,
        scene,
        body,
        apiKey,
        send,
        signal: chatAbort.signal,
        chatAbort,
        io,
        routeResult,
        evolutionQueue: opts.evolutionQueue,
        turnIntent,
      }
      try {
        await runConversationTurn(turnParams)
      } catch (err) {
        // #657: context overflow → compact the segment, then retry once.
        if (!isContextOverflowError(err)) throw err
        send({ type: 'compaction_started' })
        await ensureSessionCompaction(
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
          ctx.eventLog.count(),
          patientHash || undefined,
        )
        send({ type: 'compaction_completed' })
        await runConversationTurn(turnParams)
      }
    } catch (err: any) {
      send({ type: 'error', message: err.message || 'Chat failed' })
    } finally {
      sseEnd()
    }
}
