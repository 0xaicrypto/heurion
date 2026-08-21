/**
 * #621 — 知识库语义自动注入。
 *
 * 用户消息后、LLM 调用前,自动检索知识库(Facts + Knowledge)Top-K,
 * 作为 system 片段注入(带来源标注)。复用 keywordSearch(与 kb_search
 * 同源),控制预算与相关性阈值。
 */
import { keywordSearch, type SearchResult } from './knowledge-command-handler.js'
import type { FactsStore, KnowledgeStore } from '../../evolution/stores.js'
import { estimateTokens } from '../../common/token-estimate.js'

export interface KnowledgeInjectOptions {
  /** 注入文件/条目上限(默认 3)。 */
  maxItems?: number
  /** 单条目注入字符上限(默认 ~4K token 折算字符)。 */
  maxCharsPerItem?: number
  /** 相关性分数阈值,低于则整体不注入。 */
  minScore?: number
  /** 注入片段总字符上限。 */
  maxTotalChars?: number
}

export const KB_INJECT_HEADER = '## 知识库参考(自动注入)'

/**
 * 检索并格式化注入片段。命中且通过阈值 → 返回带来源的 system 片段;
 * 否则返回空串(不注入)。
 */
export function buildKnowledgeInjection(
  query: string,
  facts: FactsStore,
  knowledge: KnowledgeStore,
  options: KnowledgeInjectOptions = {},
): string {
  const maxItems = options.maxItems ?? 3
  const maxCharsPerItem = options.maxCharsPerItem ?? 4096
  const minScore = options.minScore ?? 1
  const maxTotalChars = options.maxTotalChars ?? 12_000

  if (!query || !query.trim()) return ''
  const results = keywordSearch(query, facts, knowledge)
  if (results.length === 0) return ''

  const items = results.filter((r) => r.score >= minScore).slice(0, maxItems)
  if (items.length === 0) return ''

  const lines: string[] = [KB_INJECT_HEADER]
  for (const item of items) {
    const src = item.kind === 'knowledge' ? item.source : item.source
    const content = item.content.slice(0, maxCharsPerItem)
    lines.push(`- [${item.kind}] (${src}) ${content}`)
  }

  let text = lines.join('\n')
  if (text.length > maxTotalChars) text = text.slice(0, maxTotalChars) + '\n…(已截断)'
  return text
}

/** 注入片段的 token 估算(供预算联动判断)。 */
export function injectionTokens(query: string, facts: FactsStore, knowledge: KnowledgeStore, options?: KnowledgeInjectOptions): number {
  return estimateTokens(buildKnowledgeInjection(query, facts, knowledge, options))
}