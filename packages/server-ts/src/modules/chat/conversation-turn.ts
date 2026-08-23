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
import { buildAttachmentParts, enforceTotalBudget, selectProjectionInputs } from './chat-context.js'
import { buildKnowledgeInjection } from '../../modules/knowledge/knowledge-inject.js'
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
  send: (chunk: any) => void
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
  const { userId, ctx, sid, patientHash, scene, body, apiKey, send, signal, chatAbort, io, routeResult, turnIntent } = p

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
    await upsertSessionRow(userId, sid, body.text.slice(0, 50))
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
  // #598: 全局输出格式规范 — 模型常用非标准 Markdown(不标准表格
  // 分隔行、用代码围栏包裹标点),导致前端渲染成乱码/代码块。
  const OUTPUT_FORMAT_RULES = `
## 输出格式规范
- 使用标准 Markdown 语法。表格的分隔行必须是 | --- | --- | 形式;不要写成 |--、---| 等不标准形式。
- 展示单个标点或字符修改(如 .. → .)时,用普通文本或引号说明即可,禁止用代码围栏(\`\`\`)或反引号包裹标点、符号或单个字符。
- 代码围栏(\`\`\`)仅用于真实代码、命令、JSON 等;不要把普通文字、术语或符号放进去。
- 行内反引号仅用于真正的行内代码。
`
  // #621: 知识库语义自动注入 — 用户消息后自动检索 Top-K 知识作为
  // system 片段(带来源)。患者场景已有患者知识自动带,不重复注入;
  // 文档场景也注入(参考资料)。
  const kbInjection = scene === 'patient'
    ? ''
    : buildKnowledgeInjection(body.text, ctx.facts, ctx.knowledge)
  // #620: 用户显式选定的知识库文章(知识库选择器)→ 注入为 system 片段.
  const pickedIds: string[] = Array.isArray(body.picked_kb_ids) ? body.picked_kb_ids.map(String) : []
  let pickedInjection = ''
  if (pickedIds.length > 0 && !scene.startsWith('patient')) {
    try {
      // #628: 选择器现在同时返回合成文章(article)与上传文件(document)。
      // article 注入内容;document 读磁盘原文(docx/pdf/文本,失败降级为文件名)。
      const articles = (ctx.memory.graph.getCurrentNodesByType('article') as any[])
        .filter((n: any) => n.type === 'article' && pickedIds.includes(n.stableId))
        .slice(0, 3)
      const docs = (ctx.memory.graph.getCurrentNodesByType('document') as any[])
        .filter((n: any) => n.type === 'document' && pickedIds.includes(n.stableId))
        .slice(0, 3)
      const { extractTextFromUpload } = await import('../../lib/document-extractor.js')
      const docBlocks: string[] = []
      for (const d of docs) {
        const text = await extractTextFromUpload(userId, d.stableId, { maxChars: 4000 })
        docBlocks.push(`- [${d.name}] ${(text || d.name).slice(0, 4000)}`)
      }
      const articleBlocks = articles.map((a) => `- [${a.title}] ${String(a.content || '').slice(0, 4000)}`)
      if (docBlocks.length > 0 || articleBlocks.length > 0) {
        pickedInjection = '\n## 用户选定知识库参考\n' + [...articleBlocks, ...docBlocks].join('\n')
      }
    } catch { /* best-effort */ }
  }
  // R1 (#98): assemble the system prompt from typed context segments —
  // hash-snapshot per user so stable segments stay byte-identical
  // (provider prompt-cache friendly) and changes are diffable.
  let systemPrompt = projected.systemPrompt + OUTPUT_FORMAT_RULES + studyContext + docContext
  if (kbInjection) systemPrompt += '\n\n' + kbInjection
  if (pickedInjection) systemPrompt += pickedInjection
  try {
    const { computeSegments, saveSnapshot, loadSnapshot, renderSystemPrompt } = await import('../../memory/context-sources.js')
    const prev = loadSnapshot(userId)
    const segments: Array<{ key: string; text: string }> = [
      ...(projected.segments || []),
      ...(studyContext ? [{ key: 'study_context', text: studyContext }] : []),
      ...(docContext ? [{ key: 'document_context', text: docContext }] : []),
      // #628-fix: 知识库注入必须作为 segment 进入渲染管线 — 此前仅追加到
      // 局部 systemPrompt,renderSystemPrompt 按 segments 重建后注入被静默丢弃
      // (#620 选择器/#621 语义注入实际从未到达 LLM)。
      ...(kbInjection ? [{ key: 'knowledge_inject', text: kbInjection }] : []),
      ...(pickedInjection ? [{ key: 'picked_kb', text: pickedInjection }] : []),
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

  // §3.4 (#194): enforce a TOTAL token budget across all assembled
  // messages. History is trimmed oldest-first; the system prompt is
  // truncated as a last resort so a pathological projection can never
  // blow the context window.
  const maxTotalTokens = parseInt(process.env.MAX_TOTAL_TOKENS || '64000', 10)
  const trimmedTurns = enforceTotalBudget(messages, maxTotalTokens)
  if (trimmedTurns > 0) {
    send({
      type: 'context_info',
      text: `Context trimmed: ${trimmedTurns} earlier turns dropped to fit the total token budget.`,
      kind: 'projection',
    })
  }

  // #621: 知识库注入后超预算 — 历史被裁剪时同步触发压缩(async),
  // 压缩后历史从新 cursor 开始,后续轮次预算回落到低位。
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
