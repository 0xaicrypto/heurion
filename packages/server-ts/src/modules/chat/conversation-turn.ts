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
import { deepseekStream, LlmTruncatedError, resolveTurnTimeoutMs } from '../../common/llm.js'
import { resolveActiveModel, type ChatContentPart } from '../../common/llm-gateway.js'
import type { EvolutionQueue } from '../evolution/evolution.queue.js'
import { getUserContext, buildCachedPersona, buildFileContext } from '../shared/user-context.js'
import { buildAttachmentParts, detectImageAttachments, pickVisionTurnModel, enforceTotalBudget, selectProjectionInputs, shouldInjectPatientRoster, isResearchIntent, docSessionFactGraphView, MAX_TOTAL_TOKENS, ContextBudget, estimateMessagesTokens } from '../shared/chat-context.js'
import { estimateTokens } from '../../common/token-estimate.js'
import { buildKnowledgeInjection } from '../../modules/knowledge/knowledge-inject.js'
import { maybeJitSynthesize } from '../../modules/knowledge/jit-synthesis.service.js' // #815 JIT 兜底
import { EmbeddingService } from '../../memory/embedding/embedding.service.js' // #731 向量路接线
import { describeSummaryForInjection } from '../../memory/staleness.js' // #813 总结溯源/stale 单一判定入口
import { ContextAssembler, RequiredSegmentError, type AssemblyResult } from './context-assembler.js'
// #905: doc- 会话 docId 解析/格式校验(工具面门控与 document_context 注入共用)。
import { ToolRegistry, parseDocSessionId, type ToolContext, type EditHint } from '../../tools/tool-registry.js'
import { listInstalledPlugins, getPluginConfig } from '../plugins/plugin-installation.service.js'
import { createExecutionPlaneService } from '../execution/execution-plane.service.js'
import { runToolCallLoop, type TurnIO } from './tool-loop.js'
// P0 hotfix 2026-09: doc 执行器兜底 — tool-loop 零写回 + 编辑意图时的
// 精简上下文重跑(治 glm 27k+ 上下文工具调用可靠性坍塌)。
import { runDocExecutorFallback, shouldRunDocExecutor, PLAN_RELAY_RE } from './doc-executor.js'
// #976: 任务清单状态与接力方案渲染（common 层）。
import { loadActivePlan, planBacklog, renderPendingSteps, renderPlanBlock } from '../../common/plan-store.js'
import {
  loadHistoryBudget,
  maybeTriggerCompaction,
  triggerCompactionAfterTrim,
  upsertSessionRow,
} from './history-budget.js'
import type { TurnIntent } from './turn-intent.js'
// #921/#927: document_context builder 已拆至 doc-context-builder.ts —
// 场景规则组装(FORMAT/CHART/REVISION/CITATION/CONFIRM)随 builder 迁移。
import { buildDocumentContext } from './doc-context-builder.js'
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
  const budget = new ContextBudget()
  const layer3FactHashes = new Set((projectionInputs.facts as any[]).map((f) => factContentHash(f)))
  // #756: 注入透明化 — 本轮实际进入 system 的 kb 条目(自动注入 + 用户钉选),
  // 装配完成后作为 citations 事件发给前端(去重)。
  type KbCitation = { kind: 'fact' | 'knowledge' | 'document'; label: string; sourceId: string }
  const kbCitations: KbCitation[] = []
  /** 由图谱解析用户可读标签;失败时回退原始 id。 */
  const resolveKbLabel = (c: ReturnType<typeof getUserContext> extends never ? never : any, it: { kind: string; label: string; stableId?: string }): string => {
    try {
      if (it.kind === 'document' && it.stableId) {
        const docId = it.stableId.split('::')[0]
        const node = c.memory.graph.getLatestByStableId(docId) as { name?: string } | undefined
        return `📄 ${node?.name || docId}`
      }
      if (it.kind === 'knowledge' && it.stableId) {
        const summaryId = it.label.replace(/^knowledge:/, '')
        const node = c.memory.graph.getLatestByStableId(summaryId) as { title?: string } | undefined
        return `📖 ${node?.title || summaryId}`
      }
      return `🧠 相关事实`
    } catch {
      return it.label || it.kind
    }
  }
  // #868: 编辑定位提示 — document_context builder 组装期间回填焦点段/
  // 选中文本,工具执行期(edit_document rangeEdit)读取做焦点优先匹配。
  const editHint: EditHint = {
    focusSectionContent: null,
    focusIndex: null,
    focusTitle: null,
    selectionText: null,
  }
  const assembler = new ContextAssembler([
    {
      // #971: 任务清单稳定段 — activePlan 在所有段之前注入（最高注意力
      // 位置）;无清单时空串。普通 chat 与 doc 会话通用（账本机制统一）。
      key: 'task_plan',
      fallbackOrder: 1,
      build: async () => {
        const plan = await loadActivePlan(userId, sid).catch(() => null)
        return renderPlanBlock(plan)
      },
    },
    {
      // #5/#631: 研究上下文 — shortCode 排序保证不更新时字节稳定。
      key: 'study_context',
      fallbackOrder: 3,
      stageLabel: '正在载入研究上下文…',
      build: async (input) => {
        // #894: 研究上下文按需注入 — 仅消息命中研究相关意图(研究/study/
        // protocol/试验/随访/入组/方案)时注入;写作与闲聊轮次不再每轮
        // 携带研究清单(上下文预算与注意力治理)。
        if (!isResearchIntent(input.body.text)) return ''
        const studies = await prisma.researchStudy.findMany({
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
      // #905: doc- 会话 required 段 — builder 抛错(参考材料提取/查库
      // 崩溃等)不再被装配器吞成空段,而是硬失败中断本回合(错误 SSE),
      // 杜绝模型在无文档上下文状态下继续"编辑"。非 doc 会话/无效
      // sessionId 返回空串(合法降级,不算失败)。
      key: 'document_context',
      fallbackOrder: 2,
      required: true,
      stageLabel: '正在解析文档与参考材料…',
      build: async (input) => {
        // #905: docId 格式校验(对齐 documents.router 的 doc_+16hex)—
        // 此前 slice(4) 盲取,不匹配的会话按 general 处理:不注入文档段。
        const docId = parseDocSessionId(sid)
        if (!docId) return ''
        // #921/#927 拆分:builder 主体移至 doc-context-builder.ts
        // (依赖显式入参)。required 段语义/段级回退(P1)保持不变。
        // 焦点记忆:上一条 assistant 回复(模糊指令沿用上一回合焦点段)。
        const lastAssistant = ctx.eventLog
          .query({ sessionId: sid })
          .reverse()
          .find((e: any) => e.eventType === 'assistant_response')
        return buildDocumentContext({
          userId,
          docId,
          messageText: body.text,
          rawSelection: body.selection,
          editHint,
          lastAssistantContent: lastAssistant?.content ?? null,
          stage: input.stage,
        })
      },
    },
    {
      // #621/#629/#630/#627/#731: 知识库语义自动注入 — 患者过滤 + 预算自适应
      // + 跨层去重 + 向量路接线(embedding 缺省时 unified-search 自动回落词法)。
      key: 'knowledge_inject',
      // #814: 让位顺序 layer3 > knowledge_inject > picked_kb — 自动注入
      // 先于用户钉选让位(见 context-assembler.segmentFallback)。
      fallbackOrder: 0,
      stageLabel: '正在检索知识库…',
      build: (input) => buildKnowledgeInjection(input.body.text, ctx.facts, ctx.knowledge, {
        remainingBudget: input.budget.remaining(),
        excludeFactHashes: input.layer3FactHashes,
        patientHash: input.patientHash ?? undefined,
        embedding: new EmbeddingService(userId, ctx.memory),
        // #840: keyword 读路径切 graph — facts/summaries 从单一事实源取。
        // #894: doc- 会话(无患者上下文)换用过滤视图 — 患者范围的 fact
        // 节点不进入知识注入(与 roster/layer3 治理同口径,JD 隐私分心)。
        graph: sid.startsWith('doc-') && !patientHash
          ? docSessionFactGraphView(ctx.memory?.graph)
          : ctx.memory?.graph,
        // #756: 自动注入条目进入 citations 上报清单。
        onItems: (items) => items.forEach((it) => kbCitations.push({
          kind: it.kind,
          label: resolveKbLabel(ctx, it),
          sourceId: it.stableId ?? it.label,
        })),
        // #813: 总结条目附溯源增强 — 标题/源 facts 置信度摘要/stale 失效标注
        // (判定走 memory/staleness.ts 单一入口,与 curation 传播同源)。
        resolveSummary: (summaryStableId) => describeSummaryForInjection(ctx.memory.graph, summaryStableId),
        // #815: JIT 惰性合成 — 无总结覆盖的 facts 簇读时综合,异步沉淀待审。
        jitSynthesize: (q, factHits) => maybeJitSynthesize({
          userId, query: q, patientHash: input.patientHash, memory: ctx.memory, facts: factHits,
        }),
      }),
    },
    {
      // #620/#633: 用户显式选定的总结/文档(用户强制保留,不入稳定段)。
      key: 'picked_kb',
      // #814: 用户钉选最后让位。
      fallbackOrder: 1,
      stageLabel: '正在载入钉选参考…',
      build: async (input) => {
        const pickedIds: string[] = Array.isArray(input.body.picked_kb_ids) ? input.body.picked_kb_ids.map(String) : []
        if (pickedIds.length === 0 || input.scene.startsWith('patient')) return ''
        // #628: 选择器同时返回合成总结(summary)与上传文件(document)。
        const summaries = (ctx.memory.graph.getCurrentNodesByType('summary') as any[])
          .filter((n: any) => n.type === 'summary' && pickedIds.includes(n.stableId))
          .slice(0, CONTEXT_CONFIG.injection.pickedMax)
        const docs = (ctx.memory.graph.getCurrentNodesByType('document') as any[])
          .filter((n: any) => n.type === 'document' && pickedIds.includes(n.stableId))
          .slice(0, CONTEXT_CONFIG.injection.pickedMax)
        // #914: 提取走缓存版 — 钉选文件每轮重复提取(PDF 解析分钟级),
        // uploads 文件不可变,进程内 LRU 缓存直接命中(与参考材料注入
        // 同一缓存面)。缓存 key 含文件 mtime — 同名 fileId 被覆盖重写
        // 后旧提取不再命中。
        const { cachedExtractTextFromUpload } = await import('../../lib/document-extractor.js')
        const docBlocks: string[] = []
        // #fix 2026-09: 逐文件子进度 — 钉选 PDF 提取(解析+图片+公式 OCR)
        // 单文件可达数分钟,整段此前零事件,用户面对 9 分钟黑盒。
        for (let i = 0; i < docs.length; i++) {
          const d = docs[i]
          input.stage?.(`正在读取钉选文档 ${i + 1}/${docs.length}：${String(d.name || d.stableId).slice(0, 40)}`)
          const text = await cachedExtractTextFromUpload(userId, d.stableId, { maxChars: CONTEXT_CONFIG.injection.pickedCharsPerItem })
          docBlocks.push(`- [document] (${d.stableId}) ${d.name}: ${(text || d.name).slice(0, CONTEXT_CONFIG.injection.pickedCharsPerItem)}`)
        }
        const summaryBlocks = summaries.map((a) => {
          // #813: 钉选文章同样带 stale 失效标注(判定单一入口)。
          const meta = describeSummaryForInjection(ctx.memory.graph, a.stableId)
          const staleTag = meta?.stale ? ` ⚠️已过时(${meta.staleSummary || '依据已失效'}) — 引用前注意时效` : ''
          return `- [summary] (${a.stableId}) ${a.title}:${staleTag} ${String(a.content || '').slice(0, CONTEXT_CONFIG.injection.pickedCharsPerItem)}`
        })
        if (docBlocks.length === 0 && summaryBlocks.length === 0) return ''
        // #756: 钉选条目进入 citations — 📌 前缀与自动注入区分。
        summaries.forEach((a: any) => kbCitations.push({ kind: 'knowledge', label: `📌 ${a.title}`, sourceId: a.stableId }))
        docs.forEach((d: any) => kbCitations.push({ kind: 'document', label: `📌 ${d.name}`, sourceId: d.stableId }))
        return '\n## 用户选定知识库参考\n' + [...summaryBlocks, ...docBlocks].join('\n')
      },
    },
  ])
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
  const chartMeta: Array<{ url: string; chartType?: string }> = []
  const timelineTools: Array<{
    tool: string; seq: number; round?: number; argsPreview: string
    status: 'running' | 'completed' | 'error'
    resultPreview?: string; elapsedMs?: number
  }> = []
  const timelineSubs: Array<{
    id: string; task: string; status: 'running' | 'done' | 'failed'
    summaryPreview?: string; turns?: number; costTokens?: number
  }> = []
  const ioWithChart: TurnIO = {
    ...io,
    send: (chunk) => {
      // #790: TurnIO 已类型化 — 直接窄化,不再手工嗅探。
      if (chunk.type === 'chart_created') {
        chartMeta.push({ url: chunk.url, chartType: chunk.chart_type })
      } else if (chunk.type === 'tool_call' && chunk.seq !== undefined) {
        if (timelineTools.length < 40) {
          timelineTools.push({
            tool: chunk.tool,
            seq: chunk.seq,
            ...(chunk.round !== undefined ? { round: chunk.round } : {}),
            argsPreview: String(JSON.stringify(chunk.args) || '').slice(0, 120),
            status: 'running',
          })
        }
      } else if (chunk.type === 'tool_result' && chunk.seq !== undefined) {
        const entry = timelineTools.find((t) => t.seq === chunk.seq)
        if (entry) {
          entry.status = chunk.success ? 'completed' : 'error'
          if (chunk.preview) entry.resultPreview = chunk.preview.slice(0, 80)
          if (chunk.elapsed_ms !== undefined) entry.elapsedMs = chunk.elapsed_ms
        }
      } else if (chunk.type === 'subagent_started') {
        if (timelineSubs.length < 12) {
          timelineSubs.push({ id: chunk.id, task: chunk.task.slice(0, 200), status: 'running' })
        }
      } else if (chunk.type === 'subagent_done') {
        const entry = timelineSubs.find((s) => s.id === chunk.id)
        if (entry) {
          entry.status = chunk.success ? 'done' : 'failed'
          if (chunk.summary_preview) entry.summaryPreview = chunk.summary_preview.slice(0, 200)
          if (chunk.turns !== undefined) entry.turns = chunk.turns
          if (chunk.cost_tokens !== undefined) entry.costTokens = chunk.cost_tokens
        } else if (timelineSubs.length < 12) {
          timelineSubs.push({
            id: chunk.id,
            task: chunk.task.slice(0, 200),
            status: chunk.success ? 'done' : 'failed',
            ...(chunk.summary_preview ? { summaryPreview: chunk.summary_preview.slice(0, 200) } : {}),
            ...(chunk.turns !== undefined ? { turns: chunk.turns } : {}),
            ...(chunk.cost_tokens !== undefined ? { costTokens: chunk.cost_tokens } : {}),
          })
        }
      }
      io.send(chunk)
    },
  }
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
    })
    if (rescue.executedWriteTools.length > 0) {
      finalContent = rescue.finalContent || finalContent
    }
  }

  // Stream the final response
  let fullResponse = ''
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
    try {
      for await (const chunk of deepseekStream(loopMessages, apiKey, {
        model: visionModel,
        telemetryContext: { userId, workspaceId: userId, action: 'chat.main' },
        signal: chatAbort.signal,
        // #fix 2026-09: OpenCode Go 要求 per-conversation 会话头(x-opencode-session)。
        sessionId: sid,
        // #802: doc 会话长生成 TTFB 放宽(同 tool-loop — 见 resolveTurnTimeoutMs)。
        timeoutMs: resolveTurnTimeoutMs(sid),
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
    timelineTools,
    timelineSubs,
    chartMeta,
    skillCards,
    attachmentText,
    patientHash: patientHash || null,
    evolutionQueue: p.evolutionQueue,
    send,
  })
  send({ type: 'turn_complete', assistant_event_idx: ctx.eventLog.count() })
}
