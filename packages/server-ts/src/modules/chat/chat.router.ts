import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import prisma from '../../common/prisma'
import { getUserContext, buildCachedPersona, buildFileContext } from './user-context.js'
import { deepseekStream, deepseekChat, getApiKey, DEEPSEEK_PREMIUM_MODEL } from '../../common/llm.js'
import { analyzeChatForPatient, updatePatientFromFindings } from '../patients/clinical-analysis.js'
import { router, createDefaultLLMClassifier } from '../../retrieval/query-router.js'
import { buildHistoryMessages } from '../../retrieval/context-compressor.js'
import { detectDoomLoop } from '../../tools/doom-loop.js'
import { ensureSessionCompaction, getInFlightCompaction } from '../../memory/compaction.js'
import { handleKnowledgeCommand, type CommandResult } from '../knowledge/knowledge-command-handler.js'
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

export async function chatRouter(app: FastifyInstance, opts: ChatRouterOptions = {}) {
  app.addHook('preHandler', authGuard)

  app.post('/api/v1/agent/chat', async (request, reply) => {
    const body = request.body as any
    if (!body.text) return reply.status(400).send({ error: 'text required' })

    const userId = request.user!.userId
    const ctx = getUserContext(userId)
    const sid = body.session_id || `session_${Math.random().toString(36).slice(2, 10)}`
    const patientHash = body.patient_hash || null
    const apiKey = getApiKey()

    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const send = (d: unknown) => reply.raw.write(`data: ${JSON.stringify(d)}\n\n`)

    try {
      send({ type: 'turn_started', event_idx: ctx.eventLog.count() + 1, patient_hash: patientHash })

      // ── P3: Route the query before building expensive context ──
      // Use the default LLM classifier for ambiguous queries so the router
      // understands intent (e.g. "write an introduction about radiotherapy")
      // instead of relying solely on keyword patterns.
      const routeResult = await router(body.text, {
        llmClassifier: createDefaultLLMClassifier({
          userId,
          workspaceId: userId,
          action: 'router.classify',
        }),
      })
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

      // R2: stream a not-yet-shown compaction summary into the conversation.
      // A compaction evolution event that landed AFTER the last reply is
      // 'unshown' — push its Session Memory summary as a streamed message.
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
              send({ type: 'compaction_chunk', text: piece })
            }
            send({ type: 'compaction_completed' })
          }
        }
      } catch {
        // compaction summary streaming is best-effort
      }

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

      // Plugin-based document rendering — handled directly without streaming LLM output
      if (routeResult.intent === 'sidecar') {
        let patient: any = null
        if (patientHash) {
          patient = await (prisma as any).patientRecord.findFirst({
            where: { hash: patientHash, userId },
          })
        }

        // Conversation history from event log (same source as the normal
        // chat path; compacted segments are replaced by the Session Memory).
        const compacted = await (prisma as any).kbCompaction.findFirst({
          where: { userId, sessionId: sid },
          orderBy: { coveredUptoIdx: 'desc' },
        }).catch(() => null)
        const compactedUpto = compacted?.coveredUptoIdx ?? 0
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

      // #2: Read attachment content
      let attachmentText = ''
      const rawAttachments = body.attachments || []
      for (const att of rawAttachments) {
        // Accept both string (file_id) and object ({ file_id, fileId, name })
        const fid = typeof att === 'string' ? att : (att.file_id || att.fileId || '')
        const name = typeof att === 'string' ? fid.split('_').slice(1).join('_') : (att.name || '')
        if (fid) {
          const content = await readAttachmentContent(userId, fid)
          if (content) {
            attachmentText += content
            send({ type: 'context_info', text: `Attachment: ${name.slice(0, 30)}`, kind: 'attachment' })
          }
        }
      }

      let fullMessage = attachmentText ? `${attachmentText}\n\nUser query: ${body.text}` : body.text

      // Inject patient demographics + memory findings into chat context
      if (patientHash) {
        const patient = await (prisma as any).patientRecord.findFirst({
          where: { hash: patientHash, userId },
        })
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

        ctx.eventLog.append({
          timestamp: Date.now() / 1000, eventType: 'user_message', content: body.text,
          metadata: { patientHash }, agentId: userId, sessionId: sid,
        })
        ctx.eventLog.append({
          timestamp: Date.now() / 1000, eventType: 'assistant_response', content: response,
          metadata: {}, agentId: userId, sessionId: sid,
        })

        send({ type: 'reasoning_chunk', text: 'Using patient roster directly.' })
        send({ type: 'final_answer_chunk', text: response })
        send({ type: 'citations', items: [] })
        send({ type: 'turn_complete', assistant_event_idx: ctx.eventLog.count() })

        await prisma.session.upsert({
          where: { id: sid },
          update: { lastMessageAt: new Date().toISOString(), messageCount: { increment: 1 } },
          create: { id: sid, userId, title: body.text.slice(0, 50), createdAt: new Date().toISOString() },
        })
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
      // until facts/knowledge versions change).
      const persona = buildCachedPersona(userId, ctx.facts, ctx.knowledge)

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

      // #5: Conversation history from event log — newest-first under a token
      // budget (MAX_HISTORY_TOKENS / HISTORY_TURNS env-configurable).
      // Compaction replaces the covered segment with the Session Memory
      // summary — the raw covered events are NOT injected anymore, so the
      // budget genuinely recovers after a compaction.
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
      const history = ctx.eventLog
        .query({ sessionId: sid, limit: historyTurns * 2 })
        .filter((e: any) => e.idx > compactedUpto)
        .reverse()
      const { messages: historyMessages, omittedTurns, tokens: historyTokens } = buildHistoryMessages(history, {
        maxTokens: maxHistoryTokens,
        maxTurns: historyTurns,
      })
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
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: projected.systemPrompt + studyContext + docContext },
      ]

      // R2 — anchored compaction: the Session Memory (episodes, current
      // session only) carries the anchored summary; no separate store.
      // (Injected via the episodes projection layer above.)

      // R2 — anchored compaction with opencode-style delayed-sync semantics:
      // the triggering turn fires it async (no reply latency); any LATER turn
      // that arrives while it is still running awaits it before replying, so
      // the anchored summary is always injectable. Both cases surface a
      // compaction_started/compaction_completed event to the UI.
      // Compression finished: push the recovered budget so the UI resets the
      // usage bar immediately (compacted events are no longer injected).
      const sendCompactionCompleted = async () => {
        const restored = ctx.eventLog
          .query({ sessionId: sid, limit: historyTurns * 2 })
          .filter((e: any) => e.idx > compactedUpto)
          .reverse()
        const { tokens: restoredTokens } = buildHistoryMessages(restored, {
          maxTokens: maxHistoryTokens,
          maxTurns: historyTurns,
        })
        send({ type: 'compaction_completed', history_tokens: restoredTokens, history_budget: maxHistoryTokens, history_turns: historyTurns })
      }
      const inFlightCompaction = getInFlightCompaction(userId, sid)
      const shouldTrigger = omittedTurns > 0 || history.length >= historyTurns * 2
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
      messages.push({ role: 'user' as const, content: fullMessage })

      // Create tool registry for function calling
      const toolCtx: ToolContext = {
        userId,
        memory: ctx.memory,
        facts: ctx.facts,
        episodes: ctx.episodes,
        skills: ctx.skills,
        knowledge: ctx.knowledge,
        eventLog: ctx.eventLog,
      }
      const toolRegistry = new ToolRegistry(toolCtx)
      const tools = toolRegistry.definitions

      // R3 — tool-call persistence: per-session sequence numbers continue
      // across turns (and process restarts) by deriving from the log.
      const existingToolEvents = ctx.eventLog.query({ sessionId: sid }).filter((e: any) => e.eventType === 'tool_call')
      let toolSeq = existingToolEvents.length
      const doomHistory: Array<{ tool: string; argsKey: string }> = []

      const appendToolEvent = (eventType: string, content: string, metadata: Record<string, unknown>) => {
        ctx.eventLog.append({
          timestamp: Date.now() / 1000,
          eventType,
          content,
          metadata,
          agentId: userId,
          sessionId: sid,
        })
      }

      // Tool-calling loop: try up to 5 rounds of tool calls
      let fullResponse = ''
      let currentMessages = [...messages]
      const MAX_TOOL_ROUNDS = 5
      let toolRound = 0
      let finalContent = ''

      while (toolRound < MAX_TOOL_ROUNDS) {
        toolRound++
        const callResult = await deepseekChat(
          currentMessages,
          apiKey,
          {
            model: DEEPSEEK_PREMIUM_MODEL,
            maxTokens: 4096,
            telemetryContext: { userId, workspaceId: userId, action: 'chat.main' },
          },
          tools,
          (reasoning) => send({ type: 'reasoning_chunk', text: reasoning }),
        )

        if (!callResult) {
          finalContent = ''
          break
        }

        // Parse JSON response — DeepSeek returns plain text; check for function calls in the text.
        // Match all <tool_call> blocks (each may contain nested JSON in `arguments`).
        const toolCallBlocks = callResult.match(/<tool_call>([\s\S]*?)<\/tool_call>/g)
        if (toolCallBlocks && toolCallBlocks.length > 0) {
          let executedAny = false
          let toolError: string | null = null
          for (const block of toolCallBlocks) {
            try {
              const toolCall = JSON.parse(block.replace(/<\/?tool_call>/g, '').trim())
              const toolName = toolCall.name || toolCall.tool
              const toolArgs = toolCall.arguments || toolCall.args || {}
              executedAny = true

              toolSeq++
              const seq = toolSeq
              const argsPreview = String(JSON.stringify(toolArgs) || '').slice(0, 300)

              // R3: persist the state machine — pending → running →
              // completed/error — plus a tool_result event per call.
              appendToolEvent('tool_call', `${toolName}(${argsPreview})`, {
                tool: toolName, args: argsPreview, status: 'pending', seq,
              })

              // Doom-loop guard: same tool + identical args 3x consecutively.
              if (detectDoomLoop(doomHistory, toolName, toolArgs)) {
                console.warn(`[DOOM-LOOP] tool ${toolName} called 3+ times with identical args (seq ${seq})`)
                appendToolEvent('tool_call', `${toolName}(${argsPreview})`, {
                  tool: toolName, args: argsPreview, status: 'warning', seq,
                })
              }

              send({ type: 'tool_call', tool: toolName, args: toolArgs })

              appendToolEvent('tool_call', `${toolName}(${argsPreview})`, {
                tool: toolName, args: argsPreview, status: 'running', seq,
              })

              const result = await toolRegistry.execute(toolName, toolArgs)

              currentMessages.push({ role: 'assistant', content: callResult })
              currentMessages.push({
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
            } catch (err) {
              console.log('[CHAT] Tool call parse failed:', (err as Error).message)
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

        finalContent = callResult
        break
      }

      // Stream the final response
      if (finalContent) {
        const chunks = finalContent.match(/.{1,80}/g) || [finalContent]
        for (const chunk of chunks) {
          fullResponse += chunk
          send({ type: 'final_answer_chunk', text: chunk })
        }
      } else {
        // Fallback: use streaming for the response
        for await (const chunk of deepseekStream(currentMessages, apiKey, {
          model: DEEPSEEK_PREMIUM_MODEL,
          maxTokens: 4096,
          telemetryContext: { userId, workspaceId: userId, action: 'chat.main' },
        }, (reasoning) => send({ type: 'reasoning_chunk', text: reasoning }))) {
          fullResponse += chunk
          send({ type: 'final_answer_chunk', text: chunk })
        }
      }

      // Log to event log
      ctx.eventLog.append({
        timestamp: Date.now() / 1000, eventType: 'user_message', content: body.text,
        metadata: { patientHash }, agentId: userId, sessionId: sid,
      })
      ctx.eventLog.append({
        timestamp: Date.now() / 1000, eventType: 'assistant_response', content: fullResponse,
        metadata: {}, agentId: userId, sessionId: sid,
      })

      // #2: Extract takeaway + evolve facts + analyze patient chat (async evolution worker)
      if (opts.evolutionQueue) {
        opts.evolutionQueue.add({ userId, sessionId: sid, userMessage: body.text, patientHash: patientHash || undefined }).catch(() => {})
      }

      // Step 2: Analyze attached files for clinical findings only.
      // Chat-only turns skip this to avoid an extra LLM call on every message.
      if (patientHash && attachmentText) {
        const analysisText = `[FILE CONTENT]\n${attachmentText}\n[CHAT]\nUser: ${body.text}\nAI: ${fullResponse}`
        analyzeChatForPatient(userId, patientHash, analysisText, {
          userId,
          workspaceId: userId,
          action: 'clinical.analysis',
        })
          .then(findings => updatePatientFromFindings(userId, patientHash, findings))
          .catch(() => {})
      }

      // Update session
      await prisma.session.upsert({
        where: { id: sid },
        update: { lastMessageAt: new Date().toISOString(), messageCount: { increment: 1 } },
        create: { id: sid, userId, title: body.text.slice(0, 50), createdAt: new Date().toISOString() },
      })

      send({ type: 'citations', items: [] })
      send({ type: 'turn_complete', assistant_event_idx: ctx.eventLog.count() })
    } catch (err: any) {
      send({ type: 'error', message: err.message || 'Chat failed' })
    } finally {
      reply.raw.end()
    }
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
    const data = request.body as any
    if (!data) return reply.status(400).send({ error: 'No data provided' })
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
      return { facts: isolateFactsByScope(ctx.facts.all(), patientHash), episodes: [], skills: [] }
    case 'file':
      // File queries: context comes from attachments; skip accumulated memory
      return { facts: [], episodes: [], skills: [] }
    case 'mixed':
    default:
      // Ambiguous or summary questions: keep full context (patient-isolated);
      // episodes are limited to the current session's un-reviewed summary.
      return {
        facts: isolateFactsByScope(ctx.facts.all(), patientHash),
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
