/**
 * #1106 — 回合上下文装配段定义（自 conversation-turn.ts 提取）。
 *
 * #637 阶段2 的 builder 注册表此前内联在 runConversationTurn 中间
 * （~190 行）。本模块把它提取为纯注册工厂：给定回合入参（用户/会话/
 * 场景/消息/ctx/editHint/citations 收集数组），返回 ContextAssembler
 * 的段定义数组。排段/预算刷新/快照渲染/段级回退仍由装配器负责 —
 * 本模块只做「注入源 → builder」的接线，行为零变更。
 *
 * 段清单与回退优先级（#814 让位序 layer3 > knowledge_inject > picked_kb）：
 *   task_plan(稳定段) / study_context(3) / document_context(2, required) /
 *   session_references(2) / knowledge_inject(0) / picked_kb(1)
 */
import prisma from '../../common/prisma.js'
import type { ChatScene } from '../../common/persona.js'
import type { getUserContext } from '../shared/user-context.js'
import { isResearchIntent, docSessionFactGraphView } from '../shared/chat-context.js'
import { CONTEXT_CONFIG } from '../../common/context-config.js'
import { buildKnowledgeInjection } from '../knowledge/knowledge-inject.js'
import { maybeJitSynthesize } from '../knowledge/jit-synthesis.service.js'
import { EmbeddingService } from '../../memory/embedding/embedding.service.js'
import { describeSummaryForInjection } from '../../memory/staleness.js'
import { type SegmentBuilderSpec } from './context-assembler.js'
import type { EditHint } from '../../tools/tool-registry.js'
import { parseDocSessionId } from '../../tools/tool-registry.js'
import { loadActivePlan, renderPlanBlock } from '../../common/plan-store.js'
import { buildSessionReferencesBlock } from './session-refs-builder.js'
import { buildDocumentContext } from './doc-context-builder.js'

/** #756: 注入透明化 — 本轮实际进入 system 的 kb 条目（自动注入 + 用户钉选）。 */
export type KbCitation = { kind: 'fact' | 'knowledge' | 'document'; label: string; sourceId: string }

/** 由图谱解析用户可读标签;失败时回退原始 id。 */
const resolveKbLabel = (c: Awaited<ReturnType<typeof getUserContext>>, it: { kind: string; label: string; stableId?: string }): string => {
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

export interface TurnSegmentBuilderArgs {
  userId: string
  sid: string
  patientHash: string | null
  scene: ChatScene
  body: { text: string; attachments?: any[]; picked_kb_ids?: string[]; selection?: string }
  ctx: Awaited<ReturnType<typeof getUserContext>>
  /** #868: 编辑定位提示 — document_context builder 组装期间回填（原对象共享）。 */
  editHint: EditHint
  /** #756: citations 收集数组 — builder 副作用回填（调用方持有引用）。 */
  kbCitations: KbCitation[]
}

export function buildTurnSegmentBuilders(args: TurnSegmentBuilderArgs): SegmentBuilderSpec[] {
  const { userId, sid, patientHash, body, ctx, editHint, kbCitations } = args
  return [
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
      // #1006: 会话引用材料（主 chat 对称化）— 与写作会话共用注入实现。
      key: 'session_references',
      fallbackOrder: 2,
      stageLabel: '正在载入引用材料…',
      build: (input) => buildSessionReferencesBlock({
        userId,
        sessionId: sid,
        messageText: input.body.text,
        stage: input.stage,
      }),
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
  ]
}
