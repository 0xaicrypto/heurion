/**
 * #544 — normal conversation turn, extracted from chat-handler.ts.
 *
 * The turn pipeline split into testable stages (#437, updated #544):
 *   chat-handler:  SSE setup / routing / sidecar+plugin dispatch
 *   tool-loop.ts:  tool-calling loop (+ turn-state.ts / tool-event-log.ts /
 *                  edit-claim-reconciliation.ts extracted units #1106)
 *   compaction.ts: compaction scheduling + history budget
 *   this file:     context assembly → messages → stream → persistence
 *                  (#1106: 段定义注册表 → turn-assembler-specs.ts;
 *                  时间线/图表收集 → turn-timeline.ts)
 *
 * Writing/document/patient scenes all land here after the generate-dispatch;
 * the caller decides which intents reach this path.
 */
import prisma from '../../common/prisma'
import { makeLogger } from '../../common/logger.js'
import type { ChatScene } from '../../common/persona.js'
import { deepseekStream, LlmTruncatedError, resolveTurnTimeoutMs } from '../../common/llm.js'
import { resolveActiveModel, type ChatContentPart } from '../../common/llm-gateway.js'
import type { EvolutionQueue } from '../evolution/evolution.queue.js'
import { getUserContext, buildCachedPersona, buildFileContext } from '../shared/user-context.js'
import { buildAttachmentParts, detectImageAttachments, pickVisionTurnModel, enforceTotalBudget, selectProjectionInputs, shouldInjectPatientRoster, MAX_TOTAL_TOKENS, ContextBudget, estimateMessagesTokens } from '../shared/chat-context.js'
import { estimateTokens } from '../../common/token-estimate.js'
import { ContextAssembler, RequiredSegmentError, type AssemblyResult } from './context-assembler.js'
// #905: doc- 会话 docId 解析/格式校验(工具面门控与 document_context 注入共用)。
import { ToolRegistry, type ToolContext, type EditHint } from '../../tools/tool-registry.js'
import { listInstalledPlugins, getPluginConfig } from '../plugins/plugin-installation.service.js'
import { createExecutionPlaneService } from '../execution/execution-plane.service.js'
import { runToolCallLoop, type TurnIO } from './tool-loop.js'
// #1106: 时间线/图表收集器与段定义注册表提取自本文件。
import { TurnTimelineCollector } from './turn-timeline.js'
import { buildTurnSegmentBuilders, type KbCitation } from './turn-assembler-specs.js'
// #1033: fallback 流式通道的 <tool_call> 过滤（历史里带原始调用时模型会复读）。
import { createToolCallStreamFilter, stripToolCallBlocks } from './tool-call-text.js'
import { TurnBudget, turnBudgetExhaustedNotice, type TurnBudgetExhaustReason } from './turn-budget.js'
// P0 hotfix 2026-09: doc 执行器兜底 — tool-loop 零写回 + 编辑意图时的
// 精简上下文重跑(治 glm 27k+ 上下文工具调用可靠性坍塌)。
import { runDocExecutorFallback, shouldRunDocExecutor, PLAN_RELAY_RE } from './doc-executor.js'
// #976: 任务清单状态与接力方案渲染（common 层）。
import { loadActivePlan, planBacklog, renderPendingSteps } from '../../common/plan-store.js'
import {
  loadHistoryBudget,
  maybeTriggerCompaction,
  triggerCompactionAfterTrim,
  upsertSessionRow,
} from './history-budget.js'
import type { TurnIntent } from './turn-intent.js'
import { factContentHash } from '../../common/fact-render.js'
import { CONTEXT_CONFIG } from '../../common/context-config.js'
import type { SendEvent } from './chat-sse.js'
import { runPostTurnPipeline } from './post-turn-pipeline.js'

const log = makeLogger('chat.conversation')

/** #6: per-patient LLM analysis throttle (ms) — avoid an extra call per message. */

/** Fetch the patient record (or null) for the chat scope. */
export async function findPatient(userId: string, patientHash?: string | null): Promise<any | null> {
  if (!patientHash) return null
  return prisma.patientRecord.findFirst({ where: { hash: patientHash, userId } })
}

export interface ConversationTurnParams {
  userId: string
  ctx: Awaited<ReturnType<typeof getUserContext>>
  sid: string
  patientHash: string | null
  scene: ChatScene
  body: { text: string; attachments?: any[]; picked_kb_ids?: string[]; selection?: string }
  apiKey: string
  send: SendEvent
  signal: AbortSignal
  chatAbort: AbortController
  io: TurnIO
  routeResult: Awaited<ReturnType<typeof import('../../retrieval/query-router.js').router>>
  evolutionQueue?: EvolutionQueue
  turnIntent: TurnIntent
}

/**
 * The normal conversation path: attachments → patient/roster/file context →
 * persona+projection → studies → history → doc context → KB injection →
 * compaction → message assembly → budget enforcement → tool loop → stream →
 * persistence. All SSE events for the turn are sent through `send`.
 */
export async function runConversationTurn(p: ConversationTurnParams): Promise<void> {
  const { userId, ctx, sid, patientHash, scene, body, apiKey, send, chatAbort, io, routeResult, turnIntent } = p

  // #2/#544: 附件 → 对话内容(图片多模态/超限降级/文本注入)由
  // buildAttachmentParts 纯函数处理;事件说明在此发送。
  // #fix: 视觉能力按本回合实际调用模型判定,并做模型自适应 — 图片附件
  // + 当前模型纯文本时自动切换到视觉模型(deepseek/opencode 同源端点),
  // 否则按文本降级提示。
  // #fix 2026-09: 主回合模型走 resolveActiveModel()(admin 覆盖 → env
  // DEFAULT_LLM_MODEL → legacy) — 此前硬编码 DEEPSEEK_PREMIUM_MODEL,生产
  // env DEFAULT_LLM_MODEL=glm-5.3-flash 被完全绕过,且 Console Go 上游对
  // deepseek-v4-flash 不稳定(400 stub + 600s 挂死),全回合失败。
  const turnModel = resolveActiveModel()
  const hasImageAttachments = await detectImageAttachments(userId, body.attachments)
  const { model: visionModel, vision, switched } = pickVisionTurnModel({ turnModel, hasImages: hasImageAttachments })
  if (switched) {
    send({
      type: 'context_info',
      text: `当前模型 ${turnModel} 不支持图片输入,已自动切换到视觉模型 ${visionModel} 处理本回合`,
      kind: 'attachment',
    })
  }
  const { parts: userParts, attachmentText, notes: attachmentNotes } = await buildAttachmentParts(body.attachments, {
    userId,
    vision,
  })
  for (const note of attachmentNotes) {
    send({ type: 'context_info', text: note, kind: 'attachment' })
  }

  let fullMessage = attachmentText ? `${attachmentText}\n\nUser query: ${body.text}` : body.text

  // #627: patient user-message 块只保留 demographics 级信息 — 临床发现
  // 由 projection layer3(患者 facts 隔离)承担,避免同一患者事实在
  // user message + patient_context 段 + layer3 三处各出现一次。
  if (patientHash) {
    const patient = await findPatient(userId, patientHash)
    const parts: string[] = ['## Current Patient Context']
    if (patient) {
      if (patient.initials) parts.push(`- Name: ${patient.initials}`)
      if (patient.age) parts.push(`- Age: ${patient.age}`)
      if (patient.sex) parts.push(`- Sex: ${patient.sex}`)
      if (patient.chiefComplaint) parts.push(`- Chief Complaint: ${patient.chiefComplaint}`)
    }
    if (parts.length > 1) {
      send({ type: 'context_info', text: parts.join('\n'), kind: 'patient_context' })
      fullMessage = parts.join('\n') + '\n\n' + fullMessage
    }
  }

  // #636: roster 按场景裁剪 — patient scene(或患者相关意图)全量注入
  // (含 age/sex/CC);'list my patients' 类确定性查询走下方独立路径。
  // #894: 注入治理(事故根因③) — roster 仅在患者意图时注入;doc- 写作
  // 会话与 general 闲聊不再无条件注入患者名单(哪怕简化版),空名单占位
  // 「No patients registered yet.」同样仅患者意图时注入。
  const allPatients = await prisma.patientRecord.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: CONTEXT_CONFIG.scene.rosterMax,
  })
  const isPatientIntent = shouldInjectPatientRoster({ sessionId: sid, patientHash, text: body.text })
  if (isPatientIntent) {
    // 患者意图回合全量注入(含 age/sex/CC);#894 后非患者意图回合不再注入
    // (#636 的简化版名单随之退役)。
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
    await upsertSessionRow(userId, sid, body.text.slice(0, 50))
    return
  }

  // Inject recent file context for the patient
  if (patientHash) {
    // #730: FileIndex is a real table now — no silent degradation.
    const recentFiles = await prisma.fileIndex.findMany({
      where: { userId, patientHash, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: CONTEXT_CONFIG.scene.recentFilesMax,
    })
    if (recentFiles.length > 0) {
      const fileCtx = buildFileContext(recentFiles.map((f) => ({
        file_id: f.id,
        name: f.name,
        size_bytes: f.sizeBytes,
        createdAt: f.createdAt,
      })))
      send({ type: 'context_info', text: fileCtx, kind: 'file_context' })
      fullMessage = fileCtx + '\n\n' + fullMessage
    }
  }

  // Build dynamic persona from user's accumulated knowledge (K5: cached
  // until facts/knowledge versions change). #510: persona variant follows
  // the entry scene so non-patient scenes stop inheriting the
  // patient-centric guidance.
  // #840: persona 渲染切 graph(单一事实源;缓存版本信号沿用 legacy store)。
  const persona = buildCachedPersona(userId, ctx.facts, ctx.knowledge, scene, ctx.memory)

  // #2: Weighted attention context projection (filtered by router intent)
  const projectionInputs = selectProjectionInputs(routeResult, ctx, patientHash, sid)
  // #841 环④: Layer 4 按需激活 — 数据源从 LearnedSkill 全量换为 graph
  // SkillNode trigger 匹配(零 LLM;answer/uncertain 回合不激活)。
  let skillCards: any[] = []
  try {
    const { matchSkillsForTurn } = await import('../skills/activation.js')
    const skillNodes = (ctx.memory?.graph.getCurrentNodesByType('skill') ?? []) as any[]
    skillCards = matchSkillsForTurn({
      skills: skillNodes,
      taskKind: turnIntent.action === 'answer' ? '' : turnIntent.action,
      queryText: `${body.text} ${scene}`,
      uncertain: turnIntent.needsClarify === true,
    })
  } catch { /* best-effort — 激活失败退回空索引 */ }
  const projected = await ctx.orchestrator.projection.project({
    userId, patientHash,
    persona,
    facts: projectionInputs.facts,
    episodes: projectionInputs.episodes,
    skills: skillCards as any,
  })
  send({ type: 'context_info', text: projected.budget.map((b: any) => `${b.layer}: ${b.tokens}t/${b.items}i`).join(' | '), kind: 'projection' })

  // #5: Conversation history under a token budget; compaction replaces
  // the covered segment with the Session Memory summary.
  const {
    history,
    historyMessages,
    omittedTurns,
    historyTokens,
    maxHistoryTokens,
    historyTurns,
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

  // #637 阶段2: system 侧装配走 ContextAssembler — 各注入源注册为独立
  // builder(不再往 runConversationTurn 中间插代码),装配器负责排段
  // (稳定段前置/动态段尾部 #631)、预算刷新(#630)、快照渲染(#98)、
  // 出口断言与段级回退(#635)。
  // #1106: 段定义注册表提取至 turn-assembler-specs.ts — 本处仅保留装配
  // 编排（预算对象/层3 hash/citations 数组/editHint 共享引用不变）。
  const budget = new ContextBudget()
  const layer3FactHashes = new Set((projectionInputs.facts as any[]).map((f) => factContentHash(f)))
  const kbCitations: KbCitation[] = []
  // #868: 编辑定位提示 — document_context builder 组装期间回填焦点段/
  // 选中文本,工具执行期(edit_document rangeEdit)读取做焦点优先匹配。
  const editHint: EditHint = {
    focusSectionContent: null,
    focusIndex: null,
    focusTitle: null,
    selectionText: null,
  }
  const assembler = new ContextAssembler(buildTurnSegmentBuilders({
    userId, sid, patientHash, scene, body, ctx, editHint, kbCitations,
  }))
  // #fix: 上下文组装(文档分段/参考材料提取)可能耗时数秒 — 等待期给
  // 用户可见的进度提示(前端 context_info 过滤后展示)。
  if (sid.startsWith('doc-')) {
    send({ type: 'context_info', text: '正在读取文档与参考资料…', kind: 'file_context' })
  } else {
    send({ type: 'context_info', text: '正在整理上下文…', kind: 'file_context' })
  }
  // #fix 2026-09: 组装阶段逐段进度 — 慢段(文档解析/知识检索)此前只有一条
  // 静态提示,5 分钟无任何变化;现在每个动态段开始构建时实时下发阶段文案,
  // 状态行随阶段推进。失败静默(进度提示绝不阻塞组装)。
  const sendStage = (label: string) => {
    try {
      send({ type: 'context_info', text: label, kind: 'file_context' })
    } catch { /* best-effort */ }
  }
  let assembled: AssemblyResult
  try {
    assembled = await assembler.assemble({
      userId, sid, patientHash, scene, body, ctx,
      projected, budget, layer3FactHashes, historyTokens,
    }, sendStage)
  } catch (err) {
    // #905: required 段(document_context)硬失败 — 不带残缺上下文进 LLM,
    // 上抛走 chat-handler 的现有错误 SSE 通道(error 事件 + llm_error 落库)。
    if (err instanceof RequiredSegmentError) {
      log.error('required context segment failed — turn aborted before LLM', {
        sessionId: sid, key: err.key, issues: err.telemetry,
      })
      throw new Error(`写作会话的文档上下文读取失败，本回合已中止。请重试；若持续出现，请刷新页面后重新进入该写作会话。（${(err as Error).message.slice(0, 160)}）`)
    }
    throw err
  }
  if (assembled.telemetry.length > 0) {
    log.warn('context assembly telemetry (required segments degraded)', { issues: assembled.telemetry })
  }
  // #fix: 组装完成 → 显式切换到生成阶段 — 此前状态行停在最后一个组装段
  // (如「正在载入钉选参考…」),LLM 长思考/上游排队期间用户误以为还在
  // 读文件(实测 9-11 分钟黑盒后 600s 超时报错)。
  send({ type: 'context_info', text: '上下文就绪，AI 正在生成…（长任务可能需要数分钟）', kind: 'file_context' })
  const systemPrompt = assembled.systemPrompt
  const segmentState = assembled.segmentState
  const segmentRenderFiltered = assembled.renderFiltered
  // #511: content may carry multimodal parts (images) on the user turn.
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ChatContentPart[] }> = [
    { role: 'system', content: systemPrompt },
  ]

  // R2 — anchored compaction (delayed-sync): fires async; a later turn
  // awaits the in-flight run. Surfaced via compaction_started/completed.
  await maybeTriggerCompaction({
    userId, sid, patientHash, ctx, send,
    history, historyMessages, omittedTurns, historyTurns, maxHistoryTokens,
  })

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

  // §3.4 (#194) + #635: enforce a TOTAL token budget across all assembled
  // messages. 先段级回退 — 按 builder fallbackOrder 逆序整段移除尾部
  // 动态段(picked_kb → knowledge_inject → document_context → study_context),
  // 避免字符切片截断半句话/半截 markdown 结构;全部移除仍超预算才落到
  // enforceTotalBudget 的字符级兜底(保留 persona)。与 #630 组装时预算
  // 控制形成双层保障。
  const maxTotalTokens = MAX_TOTAL_TOKENS
  const { droppedSegments } = assembler.segmentFallback(
    messages, maxTotalTokens, segmentState, segmentRenderFiltered,
    estimateMessagesTokens as any,
  )
  // #637: 回退后刷新预算视图 — 观测与事件输出用同一对象。
  budget.allocateSystem(estimateTokens(systemPrompt))
  if (droppedSegments.length > 0) {
    send({
      type: 'context_info',
      text: `Context segments dropped to fit the total token budget: ${droppedSegments.join(', ')}.`,
      kind: 'projection',
    })
  }
  const trimmedTurns = enforceTotalBudget(messages, maxTotalTokens)
  if (trimmedTurns > 0) {
    send({
      type: 'context_info',
      text: `Context trimmed: ${trimmedTurns} earlier turns dropped to fit the total token budget.`,
      kind: 'projection',
    })
  }
  // #630: system 侧预算统计 — 与 history 口径统一(maxTotal 为唯一上限),
  // 让 context_usage 可观测 system 实际消耗与回退情况。
  send({
    type: 'context_usage',
    history_tokens: historyTokens,
    history_budget: maxHistoryTokens,
    history_turns: historyTurns,
    omitted_turns: omittedTurns,
    will_compact: omittedTurns > 0 || history.length >= historyTurns * 2,
    system_tokens: budget.usage().system_tokens,
    system_budget: budget.usage().system_budget,
    dropped_segments: droppedSegments,
  })

  // #621: 知识库注入后超预算 — 历史被裁剪时同步触发压缩(async),
  // 压缩后历史从新 cursor 开始,后续轮次预算回落到低位。
  const kbInjection = segmentState?.['knowledge_inject']?.text ?? ''
  if (trimmedTurns > 0 && kbInjection && !sid.startsWith('doc-') && sid !== '') {
    try {
      triggerCompactionAfterTrim({
        userId, sid, patientHash, ctx, send,
        history, historyMessages, omittedTurns, historyTurns, maxHistoryTokens,
      })
    } catch { /* best-effort */ }
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
    // #666: plugin-gated tool availability (render_chart / render_scene /
    // browser_task) — modules layer provides the port, tools stay decoupled.
    isPluginInstalled: async (pluginId) => {
      const installed = await listInstalledPlugins(userId)
      return installed.some((i) => i.pluginId === pluginId && i.enabled)
    },
    getPluginConfig: (pluginId) => getPluginConfig(userId, pluginId),
    // #828: turn abort — 客户端断开/停止/watchdog 时工具与子代理可感知，
    // 不再空跑烧 token。
    signal: chatAbort.signal,
    // #831: 子代理可见性端口 — spawn_subagent 批量扇出的
    // started/progress/done 直接进本回合 SSE 流。
    emitSubagentEvent: (ev) => send(ev),
    // #766: insert_asset plot 渲染 — execution plane 端口（modules 层提供）。
    executionPlane: createExecutionPlaneService(),
    // #939: figure 渲染管线 port（mermaid/公式 → 托管图片行）—
    // modules/figures 注入,tools 层零 modules import(#672 分层)。
    // #960: ensureFigure 面向 deck v2 figure block（SVG 产物 → 数据 URL）。
    figurePipeline: {
      resolveBody: async (uid, bodyText) => {
        const { resolveFiguresToImageLines } = await import('../figures/figure-markdown.js')
        const { ensureFigure } = await import('../figures/figure.service.js')
        return resolveFiguresToImageLines(uid, bodyText, ensureFigure)
      },
      ensureFigure: async (uid, source, kind, caption) => {
        const { ensureFigure } = await import('../figures/figure.service.js')
        const { issueChartToken } = await import('../../common/chart-token.js')
        const r = await ensureFigure(uid, { kind, source })
        if (!r.ok) return null
        // SVG 字节经 resolveLocalImageBlock 同口径光栅化（docx/pptx 按 PNG 声明）。
        const { resolveFigureSvg } = await import('../../tools/deck-chart-embed.js')
        const data = await resolveFigureSvg(uid, r.file.fileId)
        if (!data) return null
        const url = `/api/v1/files/preview-page/${r.file.fileId}?token=${issueChartToken(r.file.fileId, uid)}`
        return { ref: url, caption, data }
      },
    },
    // #868: 编辑定位提示(焦点段/选中文本) — rangeEdit 焦点优先匹配。
    editHint,
  }
  const toolRegistry = new ToolRegistry(toolCtx)
  // #454-followup: plugin-gated renderers (render_chart / render_scene)
  // appear in the LLM tool list only while the owning plugin is
  // installed + enabled. #510: scene-scoped tool surface.
  // #580 (TURN_INTENT_DESIGN §8-4): edit_document exposed only in doc- sessions.
  const tools = await toolRegistry.getDefinitionsForUser(scene, sid)

  // Tool-calling loop
  // #723: 拦截 chart_created — 图表 URL 随 assistant_response 的 metadata
  // 持久化,历史重载时前端才能恢复聊天里的图表(否则刷新后图"消失")。
  // #832-缺3: 同管道收集 tool_call/tool_result/subagent_* 事件 — 折叠成
  // 有界 timeline 快照随 assistant_response 落库,前端刷新后重建时间线
  // (工具芯片/子代理结果卡不再蒸发)。
  // #996/#1003: 本轮文档写回的节集合 — 写回单点随 doc_updated 下发的
  // changed_sections(实际变更节,覆盖 range-edit/full_text/insert_asset/
  // fix_document_images 全路径);随 assistant_response metadata 持久化,
  // 聊天记录成为可回溯的改动日志(刷新后"已改动"卡片仍可重建)。失败的
  // 工具调用不产生 doc_updated,因此不会假称"改了这节"。
  // #1106: 收集器提取至 turn-timeline.ts（收集策略/透传顺序零变更）。
  const timeline = new TurnTimelineCollector()
  const ioWithChart: TurnIO = timeline.wrap(io)
  // #1019: 回合级共享预算 — main 与 doc-executor rescue 使用同一个实例，
  // rescue 消费主循环剩余额度（不再各领 5 轮），推理字数/工具调用数/墙钟
  // 也是全回合口径。
  const turnBudget = new TurnBudget()
  const loopResult = await runToolCallLoop({
    currentMessages: messages,
    toolRegistry,
    tools,
    apiKey,
    io: ioWithChart,
    ctx,
    userId,
    sessionId: sid,
    model: visionModel,
    budget: turnBudget,
    // #1025: 主循环身份（rescue 在 doc-executor 内标注）。
    loop: 'main',
  })
  let finalContent = loopResult.finalContent
  const loopMessages = loopResult.messages

  // P0 hotfix 2026-09: doc 执行器兜底(executor retry)— 主回路零写回
  // 且用户消息命中编辑意图时,用精简上下文(执行器规则+文档全文+任务+方案,
  // 不含历史)只挂写回工具面重跑一轮 runToolCallLoop。执行器成功 → 采纳其
  // 汇报文本;执行器后仍零写回 → 兜底内部已诚实告知 + edit_claim_unbacked
  // 留痕,finalContent 保持原样(避免把真实产出换成空串)。非 doc 会话 /
  // 非编辑意图 / 已有写回 → 不触发,行为与既有完全一致。
  // #967: 部分执行接力 — 主回路「声称 N 项但仅写回 K 项」(对照表编造
  // 未执行条目的实际改动)时同样触发执行器,既定方案前置跳过已写入纪律。
  // #976: 接力判据 — 活跃清单 backlog + 用户「继续/重试第 K 步」语义。
  const activePlanForRescue = await loadActivePlan(userId, sid).catch(() => null)
  const planBacklogForRescue = planBacklog(activePlanForRescue)
  let rescueExhaustedReason: TurnBudgetExhaustReason | undefined
  if (shouldRunDocExecutor({
    sessionId: sid,
    userText: body.text,
    executedWriteTools: loopResult.executedWriteTools,
    unbackedClaimCount: loopResult.unbackedClaimCount,
    writeAttempts: loopResult.writeAttempts,
    writeSuccesses: loopResult.writeSuccesses,
    planBacklogCount: loopResult.planBacklogCount || planBacklogForRescue,
    relayIntent: PLAN_RELAY_RE.test(body.text.trim()),
  })) {
    const rescue = await runDocExecutorFallback({
      userId,
      sessionId: sid,
      userText: body.text,
      // #976: 清单接力 — pending 步骤优先作为既定方案（替代上轮汇报文本）。
      planText: loopResult.planPendingText || finalContent,
      planOverride: renderPendingSteps(activePlanForRescue),
      apiKey,
      io: ioWithChart,
      ctx,
      toolRegistry,
      tools,
      model: visionModel,
      unbackedClaimCount: loopResult.unbackedClaimCount,
      // #1019: 同一份回合预算 — rescue 不再另起 5 轮。
      budget: turnBudget,
    })
    if (rescue.executedWriteTools.length > 0) {
      finalContent = rescue.finalContent || finalContent
    }
    rescueExhaustedReason = rescue.exhaustedReason
  }

  // #1019/#1026: 回合预算耗尽（轮次/工具调用/推理字数/墙钟任一维度）—
  // 用户可见、可行动的熔断提示；此刻远早于 chat-handler 的 60 分钟
  // watchdog，不再让用户盯着"正在分析…"等兜底。提示同时并入 finalContent
  // 以便刷新后仍可回溯。
  const exhaustedReason = loopResult.exhaustedReason ?? rescueExhaustedReason
  if (exhaustedReason) {
    const notice = turnBudgetExhaustedNotice(turnBudget)
    send({ type: 'context_info', text: notice, kind: 'warning' })
    finalContent = finalContent ? `${finalContent}\n\n${notice}` : notice
  }

  // Stream the final response
  let fullResponse = ''
  // #1033: 双保险 — tool-loop 已清理，但 rescue/拼接路径仍可能带回原始
  // <tool_call>（含未闭合变体），进入用户可见通道前统一兜底。
  finalContent = stripToolCallBlocks(finalContent)
  if (finalContent) {
    // #fix: 分块必须带 /s 标志 — `.` 默认不匹配 \n,丢掉换行后前端拼回的
    // 回答整段粘连(markdown 表格行尾 | 与下行行首 | 相接成 ||、接 ## 成
    // |##),表格/标题/列表全部渲染崩坏。/s 让 . 匹配任意字符,分块无损。
    const chunks = finalContent.match(/[\s\S]{1,80}/gs) || [finalContent]
    for (const chunk of chunks) {
      fullResponse += chunk
      send({ type: 'final_answer_chunk', text: chunk })
    }
  } else {
    // Fallback: use streaming for the response
    // #1033 事故根因:此分支把含原始 <tool_call> 的 loopMessages 再喂给
    // 模型,且此前**不做任何清理**——模型复读调用块直接泄漏给用户。文本与
    // 推理两个通道都过流式过滤器(跨 chunk 标记 + 未闭合块)。
    const textFilter = createToolCallStreamFilter()
    const reasonFilter = createToolCallStreamFilter()
    try {
      for await (const chunk of deepseekStream(loopMessages, apiKey, {
        model: visionModel,
        telemetryContext: { userId, workspaceId: userId, action: 'chat.main' },
        signal: chatAbort.signal,
        // #fix 2026-09: OpenCode Go 要求 per-conversation 会话头(x-opencode-session)。
        sessionId: sid,
        // #802: doc 会话长生成任务 TTFB 放宽(同 tool-loop — 见 resolveTurnTimeoutMs)。
        timeoutMs: resolveTurnTimeoutMs(sid),
      }, (reasoning) => {
        const clean = reasonFilter.push(reasoning)
        if (clean) send({ type: 'reasoning_chunk', text: clean })
      })) {
        const clean = textFilter.push(chunk)
        if (!clean) continue
        fullResponse += clean
        send({ type: 'final_answer_chunk', text: clean })
      }
      const reasonTail = reasonFilter.flush()
      if (reasonTail) send({ type: 'reasoning_chunk', text: reasonTail })
      const textTail = textFilter.flush()
      if (textTail) {
        fullResponse += textTail
        send({ type: 'final_answer_chunk', text: textTail })
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

  // #846: 后处理收敛 — 引用对账/落盘/轨迹/遵循度/演化投递/患者分析/
  // 会话行/引用 chips/技能建议 全部收敛为有序 pipeline(段级 best-effort,
  // critical 段失败上抛),主路径只调 pipeline。
  await runPostTurnPipeline({
    ctx,
    userId,
    sessionId: sid,
    scene,
    bodyText: body.text,
    turnIntent,
    fullResponse,
    responseForLog: fullResponse,
    kbCitations,
    timelineTools: timeline.timelineTools,
    timelineSubs: timeline.timelineSubs,
    chartMeta: timeline.chartMeta,
    // #996/#1003: 本轮文档写回的节 → assistant metadata(聊天改动日志)。
    turnDocSections: timeline.turnDocSections,
    skillCards,
    attachmentText,
    patientHash: patientHash || null,
    evolutionQueue: p.evolutionQueue,
    send,
  })
  send({ type: 'turn_complete', assistant_event_idx: ctx.eventLog.count() })
}
