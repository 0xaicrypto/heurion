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
import { deepseekStream, LlmTruncatedError, DEEPSEEK_PREMIUM_MODEL, resolveTurnTimeoutMs } from '../../common/llm.js'
import type { ChatContentPart } from '../../common/llm-gateway.js'
import type { EvolutionQueue } from '../evolution/evolution.queue.js'
import { getUserContext, buildCachedPersona, buildFileContext } from '../shared/user-context.js'
import { buildAttachmentParts, buildDocReferenceBlocks, findUploadFileByName, detectImageAttachments, pickVisionTurnModel, enforceTotalBudget, selectProjectionInputs, MAX_TOTAL_TOKENS, ContextBudget, estimateMessagesTokens } from '../shared/chat-context.js'
import { estimateTokens, fitTextToTokens } from '../../common/token-estimate.js'
import { splitDocumentSections, resolveDocumentFocus } from '../../lib/doc-sections.js'
import { buildKnowledgeInjection } from '../../modules/knowledge/knowledge-inject.js'
import { maybeJitSynthesize } from '../../modules/knowledge/jit-synthesis.service.js' // #815 JIT 兜底
import { EmbeddingService } from '../../memory/embedding/embedding.service.js' // #731 向量路接线
import { describeArticleForInjection } from '../../memory/staleness.js' // #813 文章溯源/stale 单一判定入口
import { ContextAssembler } from './context-assembler.js'
import { ToolRegistry, type ToolContext } from '../../tools/tool-registry.js'
import { listInstalledPlugins, getPluginConfig } from '../plugins/plugin-installation.service.js'
import { createExecutionPlaneService } from '../execution/execution-plane.service.js'
import { runToolCallLoop, type TurnIO } from './tool-loop.js'
import {
  loadHistoryBudget,
  maybeTriggerCompaction,
  triggerCompactionAfterTrim,
  upsertSessionRow,
} from './history-budget.js'
import { analyzeChatForMedicalRecord, updatePatientFromFindings, updateMedicalRecordFromChat } from '../patients/clinical-analysis.js'
import type { TurnIntent } from './turn-intent.js'
// #699: 文档场景规则外置 — 提示词工程不再混在对话主流程里。
import { refUnresolvedHint, refSourceRule, documentRules, FORMAT_RULE, CHART_RULE, REVISION_RULE, CITATION_RULE, CONFIRM_RULE } from './writing-prompts.js'
import { factContentHash } from '../../common/fact-render.js'
import { CONTEXT_CONFIG } from '../../common/context-config.js'
import type { SendEvent } from './chat-sse.js'

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
  const turnModel = DEEPSEEK_PREMIUM_MODEL
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
        const articleId = it.label.replace(/^knowledge:/, '')
        const node = c.memory.graph.getLatestByStableId(articleId) as { title?: string } | undefined
        return `📖 ${node?.title || articleId}`
      }
      return `🧠 相关事实`
    } catch {
      return it.label || it.kind
    }
  }
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
        // #writing-cost: 参考材料按用户消息相关性裁剪 — 只注入命中的
        // 文件(label/文件名关键词匹配),其余降级为"仅文件名"占位;避免
        // 每次轮询都全量提取所有参考正文(多文件时成本与 TTFB 飙升)。
        // 匹配失败时保留前 N 个(有正文优先),保证模型始终有上下文可用。
        const allRefs: Array<{ id?: string; label?: string | null; snapshot?: string | null; refType?: string | null }> = refs || []
        const msgText = String(body.text || '')
        const maxFiles = CONTEXT_CONFIG.scene.docRefFilesMax
        let refsToInject = allRefs
        if (allRefs.length > maxFiles) {
          const scored = allRefs.map((r) => {
            const label = String(r.label || r.snapshot || '')
            let score = 0
            if (msgText && label && msgText.toLowerCase().includes(label.toLowerCase())) score = 10
            else if (msgText && label) {
              // 部分词命中(label 的子串出现在消息中)
              const words = label.toLowerCase().split(/[\s._-]+/).filter((w) => w.length > 2)
              if (words.some((w) => msgText.toLowerCase().includes(w))) score = 5
            }
            return { r, score }
          })
          scored.sort((a, b) => b.score - a.score)
          const top = scored.slice(0, maxFiles)
          const withBody = top.some((x) => x.score > 0)
          if (withBody) {
            // 命中时:命中文件全量 + 其余降级为文件名占位(列表可见,不注入正文)。
            refsToInject = top.map((x) => x.r)
            const placeholder = allRefs
              .filter((r) => !top.some((t) => t.r.id === r.id))
              .map((r) => ({ ...r, snapshot: `[未注入正文 — 参考文件 ${r.label || r.snapshot || r.id} 未命中当前问题]` }))
            refsToInject = [...refsToInject, ...placeholder]
          } else {
            refsToInject = top.map((x) => x.r)
          }
        }
        // #fix: 上传文件引用(PDF/DOCX/txt)按文件名定位上传并注入提取的
        // 正文,LLM 才能真正读到稿件内容(此前只有文件名)。
        const { blocks: refBlocks } = await buildDocReferenceBlocks(userId, refsToInject || [], {
          // #fix: fileIndex 优先 + 上传目录文件名兜底 — 用户上传的文件
          // 一定在磁盘上,正文注入不依赖 fileIndex 表是否有记录。
          findFileByName: async (name) => findUploadFileByName(userId, name),
        })
        const refBlock = refBlocks.join('\n\n')

        // #fix: 文件类参考材料未解析出正文时(如上传未入库),模型手里只有
        // 文件名,会误拿文件名调 ocr_image(只接受图片 file_id)而报错。
        // 明确引导:读 PDF/DOCX 正文用 import_reference,不用 ocr_image。
        // #699: 全部场景规则外置 writing-prompts.ts — 本文件只做组装。
        const refHint = refUnresolvedHint(allRefs.length > 0, refBlock)
        const refSource = refSourceRule(allRefs.length > 0)

        // #fix: 长文档分步润色 — 混合分段:有 markdown 标题按章节切,
        // 无标题按段落+token 长度兜底。文档超预算时按焦点段注入
        // (用户"继续"/"编辑第 N 段"切换焦点),模型始终只编辑可见段。
        const docText = String(doc.body || '')
        const sections = splitDocumentSections(docText, CONTEXT_CONFIG.scene.docSectionTokens)
        const docFits = estimateTokens(docText) <= CONTEXT_CONFIG.scene.docBodyTokens
        const inventory = sections.sections.map((s) => `${s.index}. ${s.title || `第 ${s.index} 段`}`).join('\n')

        // #693: 选中即引用 — 用户选中的文本(来自编辑器选区,与 body 同源)
        // 优先成为编辑目标:注入独立上下文块,焦点段定位到包含它的段。
        const selection = typeof body.selection === 'string' && body.selection.trim() ? body.selection.trim() : null

        let focus = 1
        let focusTitle = ''
        if (!docFits && sections.sections.length > 0) {
          if (selection) {
            const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
            const needle = norm(selection.slice(0, 200))
            const idx = sections.sections.findIndex((s) => norm(s.content).includes(needle))
            if (idx >= 0) {
              focus = idx + 1
              focusTitle = sections.sections[idx].title
            }
          }
          if (focusTitle === '') {
            const lastAssistant = ctx.eventLog
              .query({ sessionId: sid })
              .reverse()
              .find((e: any) => e.eventType === 'assistant_response')
            focus = resolveDocumentFocus(body.text, sections.sections, lastAssistant?.content)
            const focused = sections.sections[focus - 1]
            if (focused) focusTitle = focused.title
          }
        }
        const bodyInjection = docFits
          ? fitTextToTokens(docText, CONTEXT_CONFIG.scene.docBodyTokens)
          : fitTextToTokens(sections.sections[focus - 1]?.content || docText, CONTEXT_CONFIG.scene.docBodyTokens)

        // #fix: 文档为空 + 参考材料有内容 — 分步润色:直接开始第一步,
        // 调用 edit_document 的 old_text/new_text 把参考资料第一部分的
        // 润色结果写回草稿(正文为空时工具会自动先导入唯一的参考材料),
        // 然后询问用户是否继续下一部分。禁止停在"要不要先导入"。
        const rules = documentRules({ docFits, selection, docBodyEmpty: !docText.trim() })

        // #773: deck 资产上下文可见性 — deck 存在时注入 ## Current Deck
        // (markdown 化表示,有界),模型才能执行"把第 3 页拆成两页"类请求
        // (走 edit_deck,slide_index 定位);与 #777 上传 pptx 联动。
        let deckBlock = ''
        if (doc.deck) {
          try {
            const deckJson = JSON.parse(String(doc.deck)) as {
              title?: string
              slides?: Array<{ title?: string; content?: Array<{ type?: string; text?: string; style?: string; url?: string; caption?: string; ref?: string }> }>
            }
            const deckLines: string[] = []
            if (deckJson.title) deckLines.push(`标题：${deckJson.title}`)
            const slides = Array.isArray(deckJson.slides) ? deckJson.slides : []
            slides.forEach((s, i) => {
              deckLines.push(`${i + 1}. ${String(s?.title || '未命名页').slice(0, 200)}`)
              for (const c of Array.isArray(s?.content) ? s.content : []) {
                if (c?.type === 'image') deckLines.push(`   ![${String(c.caption || '')}](${String(c.url || c.ref || '')})`)
                else if (typeof c?.text === 'string') deckLines.push(`   - ${c.text.slice(0, 200)}`)
              }
            })
            const deckMd = fitTextToTokens(deckLines.join('\n'), CONTEXT_CONFIG.scene.docBodyTokens / 2)
            deckBlock = `\n\n## Current Deck（AI 编排的 PPT 资产 — 与正文独立,编辑它不会改动文章）\n页码定位用于 edit_deck 的 slide_index(1-based):\n${deckMd}`
          } catch {
            deckBlock = ''
          }
        }

        return `\n\n## Current Document\n标题：${doc.title}（正文约 ${Math.round(docText.replace(/\s+/g, ' ').length / 2)} 字）\n\n${docFits ? '' : `## 文档结构（共 ${sections.sections.length} 段,按${sections.mode === 'heading' ? '章节' : '长度'}划分）\n${inventory}\n\n## 当前编辑段落（第 ${focus}/${sections.sections.length} 段${focusTitle ? `「${focusTitle}」` : ''}）\n`}${bodyInjection}\n\n${selection ? `## 用户选中文本\n[用户选中的文本 — 如需修改请从此处逐字复制 old_text(空格/换行差异会被自动忽略)。]\n${selection}\n\n` : ''}## Reference Materials\n${refBlock || '(none)'}${refHint}\n\n${refSource}\n\n${rules}\n\n${FORMAT_RULE}\n\n${CHART_RULE}\n\n${REVISION_RULE}\n\n${CITATION_RULE}\n\n${CONFIRM_RULE}${deckBlock}`
      },
    },
    {
      // #621/#629/#630/#627/#731: 知识库语义自动注入 — 患者过滤 + 预算自适应
      // + 跨层去重 + 向量路接线(embedding 缺省时 unified-search 自动回落词法)。
      key: 'knowledge_inject',
      // #814: 让位顺序 layer3 > knowledge_inject > picked_kb — 自动注入
      // 先于用户钉选让位(见 context-assembler.segmentFallback)。
      fallbackOrder: 0,
      build: (input) => buildKnowledgeInjection(input.body.text, ctx.facts, ctx.knowledge, {
        remainingBudget: input.budget.remaining(),
        excludeFactHashes: input.layer3FactHashes,
        patientHash: input.patientHash ?? undefined,
        embedding: new EmbeddingService(userId, ctx.memory),
        // #756: 自动注入条目进入 citations 上报清单。
        onItems: (items) => items.forEach((it) => kbCitations.push({
          kind: it.kind,
          label: resolveKbLabel(ctx, it),
          sourceId: it.stableId ?? it.label,
        })),
        // #813: 文章条目附溯源增强 — 标题/源 facts 置信度摘要/stale 失效标注
        // (判定走 memory/staleness.ts 单一入口,与 curation 传播同源)。
        resolveArticle: (articleStableId) => describeArticleForInjection(ctx.memory.graph, articleStableId),
        // #815: JIT 惰性合成 — 无文章覆盖的 facts 簇读时综合,异步沉淀待审。
        jitSynthesize: (q, factHits) => maybeJitSynthesize({
          userId, query: q, patientHash: input.patientHash, memory: ctx.memory, facts: factHits,
        }),
      }),
    },
    {
      // #620/#633: 用户显式选定的文章/文档(用户强制保留,不入稳定段)。
      key: 'picked_kb',
      // #814: 用户钉选最后让位。
      fallbackOrder: 1,
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
        const articleBlocks = articles.map((a) => {
          // #813: 钉选文章同样带 stale 失效标注(判定单一入口)。
          const meta = describeArticleForInjection(ctx.memory.graph, a.stableId)
          const staleTag = meta?.stale ? ` ⚠️已过时(${meta.staleSummary || '依据已失效'}) — 引用前注意时效` : ''
          return `- [article] (${a.stableId}) ${a.title}:${staleTag} ${String(a.content || '').slice(0, CONTEXT_CONFIG.injection.pickedCharsPerItem)}`
        })
        if (docBlocks.length === 0 && articleBlocks.length === 0) return ''
        // #756: 钉选条目进入 citations — 📌 前缀与自动注入区分。
        articles.forEach((a: any) => kbCitations.push({ kind: 'knowledge', label: `📌 ${a.title}`, sourceId: a.stableId }))
        docs.forEach((d: any) => kbCitations.push({ kind: 'document', label: `📌 ${d.name}`, sourceId: d.stableId }))
        return '\n## 用户选定知识库参考\n' + [...articleBlocks, ...docBlocks].join('\n')
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
    // #666: plugin-gated tool availability (render_chart / render_scene /
    // browser_task) — modules layer provides the port, tools stay decoupled.
    isPluginInstalled: async (pluginId) => {
      const installed = await listInstalledPlugins(userId)
      return installed.some((i) => i.pluginId === pluginId && i.enabled)
    },
    getPluginConfig: (pluginId) => getPluginConfig(userId, pluginId),
    // #766: insert_asset plot 渲染 — execution plane 端口（modules 层提供）。
    executionPlane: createExecutionPlaneService(),
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
  const chartMeta: Array<{ url: string; chartType?: string }> = []
  const ioWithChart: TurnIO = {
    ...io,
    send: (chunk) => {
      // #790: TurnIO 已类型化 — 直接窄化,不再手工嗅探。
      if (chunk.type === 'chart_created') {
        chartMeta.push({ url: chunk.url, chartType: chunk.chart_type })
      }
      io.send(chunk)
    },
  }
  const { finalContent, messages: loopMessages } = await runToolCallLoop({
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
        model: visionModel,
        telemetryContext: { userId, workspaceId: userId, action: 'chat.main' },
        signal: chatAbort.signal,
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

  // Log the assistant response (user_message was persisted upfront)
  ctx.eventLog.append({
    timestamp: Date.now() / 1000, eventType: 'assistant_response', content: fullResponse,
    metadata: chartMeta.length > 0 ? { chart: chartMeta } : {}, agentId: userId, sessionId: sid,
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

  // #756: 注入透明化 — 本轮实际进入 system 的 kb 条目作为引用 chips。
  const seenCitation = new Set<string>()
  send({
    type: 'citations',
    items: kbCitations
      .filter((c) => !seenCitation.has(c.sourceId) && seenCitation.add(c.sourceId))
      .slice(0, 8)
      .map((c) => ({ text: c.label, source: `/app/knowledge?q=${encodeURIComponent(c.sourceId)}`, kind: c.kind })),
  })
  // #298: suggest saving a reusable procedure as a skill.
  try {
    const { looksLikeProcedure } = await import('../skills/skill-capture.service.js')
    if (looksLikeProcedure(fullResponse) && !sid.startsWith('doc-')) {
      send({ type: 'skill_capture_suggest', text: '这个流程我帮你整理成了技能，下次可以直接调用。要保存吗？' })
    }
  } catch { /* best-effort */ }
  send({ type: 'turn_complete', assistant_event_idx: ctx.eventLog.count() })
}
