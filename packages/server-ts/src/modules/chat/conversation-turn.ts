/**
 * #544 — normal conversation turn, extracted from chat-handler.ts.
 *
 * The turn pipeline split into testable stages (#437, updated #544):
 *   chat-handler:  SSE setup / routing / sidecar+plugin dispatch
 *   tool-loop.ts:  tool-calling loop
 *   compaction.ts: compaction scheduling + history budget
 *   this file:     context assembly → messages → stream → persistence
 *
 * Writing/document/patient scenes all land here after the generate-dispatch;
 * the caller decides which intents reach this path.
 */
import prisma from '../../common/prisma'
import { makeLogger } from '../../common/logger.js'
import type { ChatScene } from '../../common/persona.js'
import { deepseekStream, LlmTruncatedError, DEEPSEEK_PREMIUM_MODEL } from '../../common/llm.js'
import { providerSupportsVision, type ChatContentPart } from '../../common/llm-gateway.js'
import type { EvolutionQueue } from '../evolution/evolution.queue.js'
import { getUserContext, buildCachedPersona, buildFileContext } from './user-context.js'
import { buildAttachmentParts, enforceTotalBudget, selectProjectionInputs, MAX_TOTAL_TOKENS, ContextBudget, estimateMessagesTokens } from './chat-context.js'
import { estimateTokens } from '../../common/token-estimate.js'
import { buildKnowledgeInjection } from '../../modules/knowledge/knowledge-inject.js'
import { ContextAssembler } from './context-assembler.js'
import { ToolRegistry, type ToolContext } from '../../tools/tool-registry.js'
import { runToolCallLoop, type TurnIO } from './tool-loop.js'
import {
  loadHistoryBudget,
  maybeTriggerCompaction,
  triggerCompactionAfterTrim,
  upsertSessionRow,
} from './compaction.js'
import { analyzeChatForMedicalRecord, updatePatientFromFindings, updateMedicalRecordFromChat } from '../patients/clinical-analysis.js'
import type { TurnIntent } from './turn-intent.js'
import { factContentHash } from '../../common/fact-render.js'
import { CONTEXT_CONFIG } from '../../common/context-config.js'
import type { SendEvent } from './chat-events.js'

const log = makeLogger('chat.conversation')

/** #6: per-patient LLM analysis throttle (ms) — avoid an extra call per message. */
const chatAnalysisThrottle = new Map<string, number>()

/** Fetch the patient record (or null) for the chat scope. */
export async function findPatient(userId: string, patientHash?: string | null): Promise<any | null> {
  if (!patientHash) return null
  return (prisma as any).patientRecord.findFirst({ where: { hash: patientHash, userId } })
}

export interface ConversationTurnParams {
  userId: string
  ctx: Awaited<ReturnType<typeof getUserContext>>
  sid: string
  patientHash: string | null
  scene: ChatScene
  body: { text: string; attachments?: any[]; picked_kb_ids?: string[] }
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
  const { parts: userParts, attachmentText, notes: attachmentNotes } = await buildAttachmentParts(body.attachments, {
    userId,
    vision: providerSupportsVision(),
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
  // (含 age/sex/CC);general/chart/document 场景简化(仅姓名缩写),
  // token 显著下降;'list my patients' 类确定性查询走下方独立路径。
  const allPatients = await (prisma as any).patientRecord.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: CONTEXT_CONFIG.scene.rosterMax,
  })
  const isPatientIntent = patientHash !== null || /患者|病人|patient|roster/i.test(body.text)
  const fullRoster = isPatientIntent
  if (allPatients.length > 0) {
    const roster = fullRoster
      ? allPatients.map((p: any) => {
          const parts = [`- ${p.initials || 'Unknown'}`]
          if (p.age) parts.push(`${p.age}y/o`)
          if (p.sex) parts.push(p.sex)
          if (p.chiefComplaint) parts.push(`CC: ${p.chiefComplaint}`)
          return parts.join(', ')
        }).join('\n')
      : allPatients.map((p: any) => `- ${p.initials || 'Unknown'}`).join('\n')
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
    await upsertSessionRow(userId, sid, body.text.slice(0, 50))
    return
  }

  // Inject recent file context for the patient
  if (patientHash) {
    try {
      const recentFiles = await (prisma as any).fileIndex.findMany({
        where: { userId, patientHash, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: CONTEXT_CONFIG.scene.recentFilesMax,
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
  const projected = await ctx.orchestrator.projection.project({
    userId, patientHash,
    persona,
    facts: projectionInputs.facts,
    episodes: projectionInputs.episodes,
    skills: projectionInputs.skills,
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
  const budget = new ContextBudget()
  const layer3FactHashes = new Set((projectionInputs.facts as any[]).map((f) => factContentHash(f)))
  const assembler = new ContextAssembler([
    {
      // #5/#631: 研究上下文 — shortCode 排序保证不更新时字节稳定。
      key: 'study_context',
      fallbackOrder: 3,
      build: async () => {
        const studies = await (prisma as any).researchStudy.findMany({
          where: { userId },
          take: CONTEXT_CONFIG.scene.studiesMax,
        })
        studies.sort((a: any, b: any) => String(a.shortCode || '').localeCompare(String(b.shortCode || '')))
        if (studies.length === 0) return ''
        let text = '\n## Active Research Studies (ALWAYS use the short_code below to refer to a study when the user mentions it)\n'
        for (const s of studies) {
          text += `- **${s.shortCode}**: ${s.name}\n`
          if (s.protocol) {
            text += `  Protocol: ${s.protocol.slice(0, CONTEXT_CONFIG.scene.protocolChars).replace(/\n/g, ' ')}\n`
          }
        }
        text += '\nIMPORTANT: When the user asks about a specific study (e.g. "NSCLC001" or any short_code), you MUST reference that short_code in your reply. When asked about details not in the protocol snippet above, suggest importing the full protocol.\n'
        return text
      },
    },
    {
      // §15.4: 写作会话注入当前文档 + 引用。
      key: 'document_context',
      fallbackOrder: 2,
      build: async () => {
        if (!sid.startsWith('doc-')) return ''
        const docId = sid.slice(4)
        const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
        if (!doc) return ''
        const refs = await (prisma as any).docReference.findMany({
          where: { userId, docId },
          orderBy: { createdAt: 'asc' },
        })
        const refBlock = (refs || [])
          .map((r: any) => `### ${r.label || r.id}\n${String(r.snapshot || r.body || '').slice(0, CONTEXT_CONFIG.scene.docRefChars)}`)
          .join('\n\n')
        return `\n\n## Current Document\n标题：${doc.title}\n\n${String(doc.body || '').slice(0, CONTEXT_CONFIG.scene.docBodyChars)}\n\n## Reference Materials\n${refBlock || '(none)'}\n\n规则：用户在编辑这份文档。回答用中文；当用户要求修改文档时，调用 edit_document 工具写回完整的新文档内容（markdown）。`
      },
    },
    {
      // #621/#629/#630/#627: 知识库语义自动注入 — 患者过滤 + 预算自适应 + 跨层去重。
      key: 'knowledge_inject',
      fallbackOrder: 1,
      build: (input) => buildKnowledgeInjection(input.body.text, ctx.facts, ctx.knowledge, {
        remainingBudget: input.budget.remaining(),
        excludeFactHashes: input.layer3FactHashes,
        patientHash: input.patientHash ?? undefined,
      }),
    },
    {
      // #620/#633: 用户显式选定的文章/文档(用户强制保留,不入稳定段)。
      key: 'picked_kb',
      fallbackOrder: 0,
      build: async (input) => {
        const pickedIds: string[] = Array.isArray(input.body.picked_kb_ids) ? input.body.picked_kb_ids.map(String) : []
        if (pickedIds.length === 0 || input.scene.startsWith('patient')) return ''
        // #628: 选择器同时返回合成文章(article)与上传文件(document)。
        const articles = (ctx.memory.graph.getCurrentNodesByType('article') as any[])
          .filter((n: any) => n.type === 'article' && pickedIds.includes(n.stableId))
          .slice(0, CONTEXT_CONFIG.injection.pickedMax)
        const docs = (ctx.memory.graph.getCurrentNodesByType('document') as any[])
          .filter((n: any) => n.type === 'document' && pickedIds.includes(n.stableId))
          .slice(0, CONTEXT_CONFIG.injection.pickedMax)
        const { extractTextFromUpload } = await import('../../lib/document-extractor.js')
        const docBlocks: string[] = []
        for (const d of docs) {
          const text = await extractTextFromUpload(userId, d.stableId, { maxChars: CONTEXT_CONFIG.injection.pickedCharsPerItem })
          docBlocks.push(`- [document] (${d.stableId}) ${d.name}: ${(text || d.name).slice(0, CONTEXT_CONFIG.injection.pickedCharsPerItem)}`)
        }
        const articleBlocks = articles.map((a) => `- [article] (${a.stableId}) ${a.title}: ${String(a.content || '').slice(0, CONTEXT_CONFIG.injection.pickedCharsPerItem)}`)
        if (docBlocks.length === 0 && articleBlocks.length === 0) return ''
        return '\n## 用户选定知识库参考\n' + [...articleBlocks, ...docBlocks].join('\n')
      },
    },
  ])
  const assembled = await assembler.assemble({
    userId, sid, patientHash, scene, body, ctx,
    projected, budget, layer3FactHashes, historyTokens,
  })
  if (assembled.telemetry.length > 0) {
    log.warn('context assembly telemetry (required segments degraded)', { issues: assembled.telemetry })
  }
  let systemPrompt = assembled.systemPrompt
  let segmentState = assembled.segmentState
  let segmentRenderFiltered = assembled.renderFiltered
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
  }
  const toolRegistry = new ToolRegistry(toolCtx)
  // #454-followup: plugin-gated renderers (render_chart / render_scene)
  // appear in the LLM tool list only while the owning plugin is
  // installed + enabled. #510: scene-scoped tool surface.
  // #580 (TURN_INTENT_DESIGN §8-4): edit_document exposed only in doc- sessions.
  const tools = await toolRegistry.getDefinitionsForUser(scene, sid)

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

  // #582 — 例 A：通用会话编辑附件（action=edit, target=attachment）时，给
  // 一条可落地出口（保存为文档 / 导出），避免"结果只留在对话里"的死路。
  if (turnIntent.action === 'edit' && turnIntent.target === 'attachment') {
    send({
      type: 'attachment_export_option',
      options: ['save_as_document', 'export_pdf', 'continue_discussion'],
    })
  }

  // #2: Extract takeaway + evolve facts + analyze patient chat (async evolution worker)
  // Writing sessions (doc-*) are excluded — their content must not
  // become global memory (leak into patient chats).
  if (p.evolutionQueue && !sid.startsWith('doc-')) {
    p.evolutionQueue.add({ userId, sessionId: sid, userMessage: body.text, patientHash: patientHash || undefined }).catch(() => {})
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
  await upsertSessionRow(userId, sid, body.text.slice(0, 50))

  send({ type: 'citations', items: [] })
  // #298: suggest saving a reusable procedure as a skill.
  try {
    const { looksLikeProcedure } = await import('../skills/skill-capture.service.js')
    if (looksLikeProcedure(fullResponse) && !sid.startsWith('doc-')) {
      send({ type: 'skill_capture_suggest', text: '这个流程我帮你整理成了技能，下次可以直接调用。要保存吗？' })
    }
  } catch { /* best-effort */ }
  send({ type: 'turn_complete', assistant_event_idx: ctx.eventLog.count() })
}
