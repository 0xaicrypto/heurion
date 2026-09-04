/**
 * #621 — 知识库语义自动注入。
 *
 * 用户消息后、LLM 调用前,自动检索知识库(Facts + Knowledge)Top-K,
 * 作为 system 片段注入(带来源标注)。复用 keywordSearch(与 kb_search
 * 同源),控制预算与相关性阈值。
 */
import type { FactsStore, KnowledgeStore } from '../../evolution/stores.js'
import { estimateTokens } from '../../common/token-estimate.js'
import { formatFactLine } from '../../common/fact-render.js' // #627 统一渲染
import { unifiedSearch } from '../../retrieval/unified-search.js' // #632 统一检索层
import type { EmbeddingService } from '../../memory/embedding/embedding.service.js' // #632 向量路
import { MAX_TOTAL_TOKENS } from '../shared/chat-context.js'
import { CONTEXT_CONFIG } from '../../common/context-config.js' // #637 集中配置

export interface KnowledgeInjectOptions {
  /** 注入文件/条目上限(默认 3)。 */
  maxItems?: number
  /** 单条目注入字符上限(默认 ~4K token 折算字符)。 */
  maxCharsPerItem?: number
  /** 相关性分数阈值,低于则整体不注入。 */
  minScore?: number
  /** 注入片段总字符上限。 */
  maxTotalChars?: number
  /** #630: 本轮剩余预算(token)。设置后按三档策略自适应条数/长度。 */
  remainingBudget?: number
  /** #627: 已注入事实的 contentHash 集 — 命中则不重复注入(跨 store 去重)。 */
  excludeFactHashes?: Set<string>
  /** #629: 患者场景按 patientHash 过滤检索范围 — 只检索该患者 facts +
   *  全局知识库文章,避免跨患者泄漏。 */
  patientHash?: string | null
  /** #632: 向量路来源(embedding);缺省或故障时回落纯词法。 */
  embedding?: EmbeddingService
  /**
   * #756: 注入透明化 — 收集本轮实际注入条目(去重后),由调用方转为
   * citations SSE 事件;回调在过滤/截断后、渲染前触发。
   */
  onItems?: (items: Array<{ kind: 'fact' | 'knowledge' | 'document'; label: string; stableId?: string }>) => void
  /**
   * #813: 知识文章溯源增强 — 解析 summary 图谱元数据(标题/源 facts
   * 置信度/来源/stale),由调用方接线(memory/staleness.ts 的
   * describeSummaryForInjection);缺省时保持原始渲染。
   */
  resolveSummary?: (summaryStableId: string) => {
    title: string
    stale: boolean
    staleSummary?: string
    sourceSummary: string
  } | undefined
  /**
   * #815: JIT 惰性合成 hook — facts 命中且无文章覆盖时读时综合。
   * 由调用方接线(jit-synthesis.service.maybeJitSynthesize);缺省不触发。
   */
  jitSynthesize?: (query: string, factHits: Array<{ stableId: string; content: string; importance?: number; sourceType?: string }>) => Promise<string | null>
}

export const KB_INJECT_HEADER = '## 知识库参考(自动注入)'

/** #815: JIT 综合块头 — 明示未审核,与正式文章区分。 */
export const JIT_INJECT_HEADER = '## 即时综合(JIT — 尚未经人工审核,仅供参考)'

/**
 * #813: 文章层引用指令 — 与 layer3 的 `[置信度, 来源]` 规则对齐。
 * 合成文章自带结论/依据/caveat 结构,注入时要求模型引用结论标注来源,
 * 不确定处以 caveat 为准(合成期幻觉已被 factId 白名单过滤)。
 */
export const KB_CITATION_RULE = '引用上方知识库摘要的结论时，请标注来源与置信度，例如（来源：《摘要标题》，置信度: 高）；标注"注意事项/caveats"的内容按不确定性对待，不要作为确定结论复述。'

/** 剩余预算占总窗口的比例分档(>30% 充足 / >10% 中等 / 其余紧张)。 */
const BUDGET_TIER_RICH = 0.3
const BUDGET_TIER_TIGHT = 0.1

/**
 * #630: 三档策略 — 预算充足多带、紧张砍量。
 * - 充足(>30%) → 3 条 × 4K
 * - 中等(>10%) → 2 条 × 3K
 * - 紧张(≤10%) → 1 条 × 2K
 * 未提供 remainingBudget 时保持旧行为(3 × 4K)。
 */
export function applyBudgetTiers(
  options: KnowledgeInjectOptions,
  maxTotalTokens: number = MAX_TOTAL_TOKENS,
): KnowledgeInjectOptions {
  const { remainingBudget, ...rest } = options
  const { injection } = CONTEXT_CONFIG
  if (remainingBudget === undefined) {
    // 旧行为: 3 × 4K（显式默认档位,供调用方一致消费）。
    return { maxItems: injection.kbItemsRich, maxCharsPerItem: injection.kbCharsRich, maxTotalChars: injection.kbTotalRich, ...rest }
  }
  const ratio = remainingBudget / Math.max(1, maxTotalTokens)
  if (ratio > BUDGET_TIER_RICH) {
    return { maxItems: injection.kbItemsRich, maxCharsPerItem: injection.kbCharsRich, maxTotalChars: injection.kbTotalRich, ...rest }
  }
  if (ratio > BUDGET_TIER_TIGHT) {
    return { maxItems: injection.kbItemsMid, maxCharsPerItem: injection.kbCharsMid, maxTotalChars: injection.kbTotalMid, ...rest }
  }
  return { maxItems: injection.kbItemsTight, maxCharsPerItem: injection.kbCharsTight, maxTotalChars: injection.kbTotalTight, ...rest }
}

/**
 * 检索并格式化注入片段。命中且通过阈值 → 返回带来源的 system 片段;
 * 否则返回空串(不注入)。
 * #632: 改用统一检索(keyword + vector RRF) — 词法精确词不降级,
 * paraphrase 命中由向量路补足。
 */
export async function buildKnowledgeInjection(
  query: string,
  facts: FactsStore,
  knowledge: KnowledgeStore,
  options: KnowledgeInjectOptions = {},
): Promise<string> {
  const opts = applyBudgetTiers(options, MAX_TOTAL_TOKENS)
  const maxItems = opts.maxItems ?? CONTEXT_CONFIG.injection.kbItemsRich
  const maxCharsPerItem = opts.maxCharsPerItem ?? CONTEXT_CONFIG.injection.kbCharsRich
  const minScore = opts.minScore ?? 1
  const maxTotalChars = opts.maxTotalChars ?? CONTEXT_CONFIG.injection.kbTotalRich
  const excludeFactHashes = options.excludeFactHashes

  if (!query || !query.trim()) return ''
  // #814: 取 3× 候选再分区截取 — 否则 RRF 排名靠后的 summary 会在
  // 排序前就被 topK 砍掉,summary 优先成为空话。
  const results = await unifiedSearch(query, facts, knowledge, {
    embedding: options.embedding,
    patientHash: options.patientHash,
    topK: maxItems * 3,
    minScore,
  })
  if (results.length === 0) return ''

  // #627: 与已注入事实(layer3 等)按 contentHash 去重,只补新事实。
  const items = results.filter((r) => !(r.kind === 'fact' && r.factHash && excludeFactHashes?.has(r.factHash)))
  if (items.length === 0) return ''

  // #814: summary 命中优先于裸 facts — knowledge 排最前,document 次之,
  // facts 仅作兜底填充剩余槽位(组内保持 RRF 原序,同序稳定)。
  const kindPriority: Record<string, number> = { knowledge: 0, document: 1, fact: 2 }
  items.sort((a, b) => (kindPriority[a.kind] ?? 9) - (kindPriority[b.kind] ?? 9))
  const selected = items.slice(0, maxItems)

  // #749: aggregate same-document chunk hits (stableId `docId::cN`) into one
  // entry so a single big file cannot crowd out other sources; extra budget
  // flows to the merged item's combined text.
  const docParts = new Map<string, { hit: typeof selected[number]; parts: string[] }>()
  const finalItems: typeof selected = []
  for (const item of selected) {
    if (item.kind === 'document' && item.stableId?.includes('::')) {
      const docKey = item.stableId.split('::')[0]
      const existing = docParts.get(docKey)
      if (existing) {
        existing.parts.push(item.content)
      } else {
        const entry = { hit: item, parts: [item.content] }
        docParts.set(docKey, entry)
        finalItems.push(entry.hit)
      }
    } else {
      finalItems.push(item)
    }
  }

  // #756: 注入透明化 — 原始条目交给调用方修饰(稳定ID 可由图谱解析标题)。
  if (options.onItems) {
    options.onItems(finalItems.map((item) => ({
      kind: item.kind,
      label: item.source,
      stableId: item.stableId,
    })))
  }
  const lines: string[] = [KB_INJECT_HEADER]
  let hasKnowledgeItem = false
  for (const item of finalItems) {
    // #749: merged document rendering — chunks joined with an ellipsis marker.
    if (item.kind === 'document') {
      const docKey = item.stableId?.split('::')[0]
      const entry = docKey ? docParts.get(docKey) : undefined
      if (entry && entry.parts.length > 1) {
        lines.push(`- [${item.kind}] (${item.source},共${entry.parts.length}个相关片段) ${entry.parts.join('\n…\n').slice(0, maxCharsPerItem * 2)}`)
        continue
      }
    }
    // #627: fact 条目与 layer3 共用统一渲染(formatFactLine),去重后
    // 同一事实表述单一;来源标注保留(id 可追踪)。
    const content = item.kind === 'fact'
      ? formatFactLine({
          category: item.category,
          importance: item.importance,
          content: item.content.slice(0, maxCharsPerItem),
          createdAt: Date.now(),
        })
      : item.content.slice(0, maxCharsPerItem)
    if (item.kind === 'knowledge') {
      // #813: 文章条目附溯源增强(标题/源 facts 置信度摘要/stale 失效标注),
      // 解析失败或调用方未接线时回退原始渲染。
      const summaryId = item.stableId ?? item.source.replace(/^knowledge:/, '')
      const meta = summaryId ? opts.resolveSummary?.(summaryId) : undefined
      if (meta) {
        hasKnowledgeItem = true
        const staleTag = meta.stale ? ` ⚠️已过时(${meta.staleSummary || '依据已失效'}) — 引用前注意时效` : ''
        const sourceTag = meta.sourceSummary ? `来源: ${meta.sourceSummary}` : '来源: 合成文章'
        lines.push(`- [knowledge] 《${meta.title}》${staleTag}(${sourceTag}) ${content}`)
        continue
      }
    }
    lines.push(`- [${item.kind}] (${item.source}) ${content}`)
  }
  if (hasKnowledgeItem) {
    lines.push('', KB_CITATION_RULE)
  } else if (options.jitSynthesize) {
    // #815: 无文章覆盖 → JIT 读时综合兜底。仅在预算充足档触发
    // (合成是追加 LLM 调用;紧张/中等档不做)。
    const rich = opts.maxItems === CONTEXT_CONFIG.injection.kbItemsRich
      && (opts.remainingBudget === undefined
        || opts.remainingBudget / MAX_TOTAL_TOKENS > BUDGET_TIER_RICH)
    const factHits = finalItems
      .filter((i) => i.kind === 'fact' && i.stableId)
      .map((i) => ({ stableId: i.stableId!, content: i.content, importance: i.importance, sourceType: i.category }))
    if (rich && factHits.length >= CONTEXT_CONFIG.injection.jitMinFacts) {
      try {
        const jit = await options.jitSynthesize(query, factHits)
        if (jit) lines.push('', JIT_INJECT_HEADER, jit)
      } catch {
        // JIT 是 best-effort 兜底 — 失败静默跳过(注入主体已可用)
      }
    }
  }

  let text = lines.join('\n')
  if (text.length > maxTotalChars) text = text.slice(0, maxTotalChars) + '\n…(已截断)'
  return text
}

/** 注入片段的 token 估算(供预算联动判断)。#632: 统一检索为异步。 */
export async function injectionTokens(query: string, facts: FactsStore, knowledge: KnowledgeStore, options?: KnowledgeInjectOptions): Promise<number> {
  return estimateTokens(await buildKnowledgeInjection(query, facts, knowledge, options))
}