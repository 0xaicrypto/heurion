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
import { makeLogger } from '../../common/logger.js'
import type { ChatStreamChunk } from '@heurion/contracts'
import { getUserContext } from '../shared/user-context.js'
import type { ChatScene } from '../../common/persona.js'
import { getApiKey } from '../../common/llm.js'
import { chatSendSchema } from '../shared/chat.dto.js'
import { router, EDIT_MARKERS } from '../../retrieval/query-router.js'
import { resolveSidecarIntent, type SidecarDecisionDetail } from '../../retrieval/intent-router.js'
import { handleKnowledgeCommand } from '../knowledge/knowledge-command-handler.js'
import { handlePluginChatRequest } from '../plugins/plugin-chat-handler.js'
import { PrismaKnowledgeGapService } from '../knowledge/knowledge-gap.service.js'
import { PrismaTelemetryService } from '../knowledge/telemetry.service.js'
import { formatCommandResult, resolveScene } from '../shared/chat-context.js'
import { resolveTargetCandidates, pickTarget, isGenerateRequest, recordTurnIntent, type TurnAction, type TurnIntent, type TurnSource, type TurnTarget } from './turn-intent.js'
import { parseDocSessionId } from '../../tools/tool-registry.js'
import { runConversationTurn, findPatient } from './conversation-turn.js'
import { ensureSessionCompaction } from '../../memory/compaction/index.js'
import { streamUnshownCompaction, loadCompactedUpto } from './history-budget.js'
import type { TurnIO } from './tool-loop.js'

/** 仅编辑语义判断（供决策表消歧——判定为编辑但存在多目标时需要澄清）。 */
function turnAction2edit(detail: SidecarDecisionDetail | undefined, text: string): boolean {
  return Boolean(detail?.vetoed) && EDIT_MARKERS.test(text)
}

const log = makeLogger('chat.handler')

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

    // #828: 回合级 watchdog — 最后防线，任何下游（LLM/工具/子代理）的挂死
    // 都不再表现为"永久转圈"。超时发可解释错误 + turn_complete，并 abort
    // 整条工具链路（ToolContext.signal 已在 conversation-turn 装配）。
    // 2026-09: 默认放宽到 1 小时 — 综述写作单回合含多轮工具+长生成，
    // 15 分钟会掐断仍在正常推进的回合（TURN_MAX_MS env 可覆盖）。
    const TURN_MAX_MS = Number(process.env.TURN_MAX_MS) || 60 * 60_000
    let turnSettled = false
    let interruptMarked = false
    const watchdog = setTimeout(() => {
      if (turnSettled) return
      log.warn('[chat] turn watchdog fired', { userId, sessionId: sid, elapsedMs: TURN_MAX_MS })
      // watchdog 是有交代的终止(错误+turn_complete 已发) — 不打中断标记。
      interruptMarked = true
      send({ type: 'error', message: `本回合执行超过 ${Math.round(TURN_MAX_MS / 60_000)} 分钟仍未完成，已中止。可将任务拆分为多步后重试。` })
      send({ type: 'turn_complete' })
      try { chatAbort.abort() } catch { /* ignore */ }
      sseEnd()
    }, TURN_MAX_MS)
    watchdog.unref?.()

    // #883: 回合中断标记 — SSE close(页面刷新/手动停止)触发 abort 且回合
    // 未正常结束时,在 eventLog 落一条助手侧标记。历史重放后用户能看到中断
    // 点与继续入口(回复「继续」接力,CONFIRM_RULE + 焦点继承保证上下文),
    // 不再是悬空的用户消息。正常完成/错误/watchdog 路径 turnSettled 已置位,
    // 不误标。
    chatAbort.signal.addEventListener('abort', () => {
      if (turnSettled || interruptMarked) return
      interruptMarked = true
      appendTurnInterruptedMarker(ctx, userId, sid)
    })

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
      // #fix: 用户可读的等待期进度提示(此前是 'Router: mixed (ruleHit=..)'
      // 技术文本;前端 context_info 按 kind 过滤展示)。
      send({ type: 'context_info', text: '正在分析你的请求…', kind: 'router' })

      await streamUnshownCompaction(userId, ctx, sid, io)

      // Knowledge commands are handled directly without calling the chat LLM
      if (routeResult.intent === 'knowledge_command') {
        const kbResult = await handleKnowledgeCommand({
          workspaceId: userId,
          userId,
          factsStore: ctx.facts,
          knowledgeStore: ctx.knowledge,
          gapService,
          memory: ctx.memory,
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

      // #776: doc- 会话路由收编 — 写作会话内一切生成请求（表格/图/导出/编排）
      // 统一交给工具循环（模型视上下文自主调 insert_asset / edit_document），
      // 旁路（触发词匹配 + 旁路裁决 + handlePluginChatRequest）只保留给主
      // chat。否则"把这篇文章做成 PPT"会被 ppt 触发词截胡进历史编内容渲染，
      // #767/#772 的导出/编排管线对最典型话术是死代码；收编后 doc 会话每回
      // 合还省一次裁决 LLM 调用。verdict 记 taken_over_by_tool_loop 供回归对比。
      const isDocSession = sid.startsWith('doc-')
      // Plugin-based document rendering — handled directly without streaming
      // LLM output. #452/#549: the main router no longer classifies sidecar
      // (its LLM fallback lacked the edit/polish exclusion and caused
      // #552-class misroutes); resolveSidecarIntent is the SINGLE authority
      // for "is this a file-generation request" — rule candidate recall →
      // LLM adjudicator → conservative fallback, all with history context.
      // #560/#561: capture the adjudication detail — telemetry-worthy verdict
      // distribution and, on 'uncertain', an intent_clarify hint for the UI
      // (the request could be a generation request, but the LLM was unsure).
      let sidecarDetail: SidecarDecisionDetail | undefined
      if (isDocSession) {
        await telemetry.record({
          userId,
          workspaceId: userId,
          category: 'sidecar',
          action: 'intent',
          metadata: { verdict: 'taken_over_by_tool_loop', llmCalls: 0, docSession: true },
        }).catch(() => {})
      } else {
        const recentTurns = ctx.eventLog.query({ sessionId: sid, limit: 40 })
          .reverse()
          .filter((evt: any) => evt.eventType === 'user_message' || evt.eventType === 'assistant_response')
          .slice(0, 6)
          .map((evt: any) => ({
            role: evt.eventType === 'user_message' ? ('user' as const) : ('assistant' as const),
            content: evt.content,
          }))
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
      }
      // #583 — 判定全量入事件日志（脱敏指纹），供审计重建与 #560 语料。
      // #578 — 用 TurnIntent（scene×action×target）驱动决策路由：generate 走插件，
      // edit/answer 回落常规对话；编辑目标冲突（附件 vs 当前草稿，例 C）要澄清。
      const candidates = resolveTargetCandidates(
        { scene, sessionId: sid, hasAttachment: Boolean(body.attachments?.length), patientHash },
      )
      const picked = pickTarget({ text: body.text, hasAttachment: Boolean(body.attachments?.length) }, candidates)
      // #905: docId 格式校验 — sessionId 非 `doc-doc_<16hex>` 格式时降级
      // general 语义:editDocumentId 不下发(不注入文档编辑目标)。
      const docSessionDocId = parseDocSessionId(sid)
      // #776: doc 会话的 action 只按确定性编辑标记照记（遥测回归对比用），
      // 真正的生成/编排决策在工具循环内由模型做出 — 旁路不参与。
      const turnIntent: TurnIntent = isDocSession ? {
        action: (EDIT_MARKERS.test(body.text) ? 'edit' : 'answer') as TurnAction,
        target: picked.target as TurnTarget,
        source: 'rule' as TurnSource,
        confidence: 0.6,
        needsClarify: false,
        clarifyOptions: [],
        payload: {
          rawText: body.text,
          patientHash: patientHash ?? undefined,
          editDocumentId: picked.target === 'current_doc' && docSessionDocId ? docSessionDocId : undefined,
        },
      } : {
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
          editDocumentId: picked.target === 'current_doc' && docSessionDocId ? docSessionDocId : undefined,
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
      // #776: doc 会话不走插件旁路 — 生成请求由工具循环承接。
      if (!isDocSession && isGenerateRequest(turnIntent)) {
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
          // #637: 插件事件流 — 载荷是 ChatStreamChunk 的子集(白名单类型
          // 透传,#695),不再 as 硬断言;插件侧发未知载荷编译期即报错。
          send: (d: ChatStreamChunk) => send(d),
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
      // #802: turn 失败落事件日志 — 与 assistant_response 对称可查,
      // 失败轮次(如 LLM TTFB 超时)不再无声消失。
      try {
        ctx.eventLog.append({
          timestamp: Date.now() / 1000,
          eventType: 'llm_error',
          content: String(err?.message || err || 'Chat failed').slice(0, 500),
          metadata: {},
          agentId: userId,
          sessionId: sid,
        })
      } catch { /* 记录失败不阻断错误路径 */ }
      send({ type: 'error', message: err.message || 'Chat failed' })
    } finally {
      // #828: settle the turn watchdog — normal completion/error paths must
      // never fire it.
      turnSettled = true
      clearTimeout(watchdog)
      sseEnd()
    }
}

/** #883: 回合中断标记 — 助手侧提示落 eventLog,历史重放可见中断点与继续
 *  入口(用户回复「继续」→ CONFIRM_RULE + 焦点继承接力)。watchdog/正常
 *  结束路径不打此标记(调用方守卫);append 失败静默(不影响中断处理)。 */
export function appendTurnInterruptedMarker(
  ctx: { eventLog: { append: (event: Omit<import('../../core/event-log.js').Event, 'idx'>) => unknown } },
  userId: string,
  sessionId: string,
): void {
  try {
    ctx.eventLog.append({
      timestamp: Date.now() / 1000,
      eventType: 'assistant_response',
      // P0 hotfix 2026-09: 去掉「已保存/已完成」暗示 — 防模型把中断标记
      // 当"已落盘"事实并在后续轮次幻觉「已完成修改」;改为明确的工具执行
      // 承诺(与 CONFIRM_RULE 行动优先一致)。
      content: '[系统提示:上一回合被中断，未执行的修改不会自动完成；回复「继续」，我会立即调用工具执行剩余工作。]',
      metadata: { interrupted: true },
      agentId: userId,
      sessionId,
    })
  } catch { /* best-effort */ }
}
