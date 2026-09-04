/**
 * #666-followup: keyword search over Facts + Knowledge stores — moved out of
 * knowledge-command-handler so `retrieval/` never imports `modules/*`
 * (unified-search used it, creating a retrieval→knowledge→retrieval cycle).
 */
import { FactsStore, KnowledgeStore } from '../evolution/stores.js'
import { LegacyFactProvider, type FactProvider } from '../memory/fact-provider.js'

export interface SearchResult {
  kind: 'fact' | 'knowledge'
  source: string
  content: string
  score: number
  /** #627: 跨 store 去重 key — fact 条目携带,注入层按它与已注入事实对比。 */
  factHash?: string
  /** #627: fact 条目的分类 — 统一渲染用(layer3 同源)。 */
  category?: string
  /** #627: fact 条目的重要性 — 统一渲染用(★ 数量)。 */
  importance?: number
  /** #748: stableId 主键 — RRF 融合键与向量路对齐,同一事实不再双份注入。 */
  stableId?: string
}

function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  // Keep Chinese characters and Latin alphanumeric tokens
  const tokens = lower.match(/[\u4e00-\u9fa5]+|[a-z0-9]+/g) || []
  // Filter out very short tokens unless Chinese
  return tokens.filter(t => t.length >= 2 || /[\u4e00-\u9fa5]/.test(t))
}

function scoreText(text: string, queryTerms: string[]): number {
  const textTokens = new Set(tokenize(text))
  if (textTokens.size === 0) return 0

  let matches = 0
  for (const term of queryTerms) {
    for (const token of textTokens) {
      if (token.includes(term) || term.includes(token)) {
        matches++
        break
      }
    }
  }

  return matches / queryTerms.length
}

/**
 * Simple keyword search over Facts and Knowledge summaries.
 * Scores by normalized keyword overlap.
 */
export function keywordSearch(
  query: string,
  factsStore: FactsStore,
  knowledgeStore: KnowledgeStore,
  factProvider?: FactProvider,
  patientHash?: string | null,
): SearchResult[] {
  const queryTerms = tokenize(query)
  if (queryTerms.length === 0) return []

  const results: SearchResult[] = []

  // #637: 注入/检索层默认走 legacy 适配器;传 provider 时(如 graph 双轨
  // 收敛)按同一接口访问 — 双 store 去重不再依赖具体存储。
  // #629: patientHash 过滤 — 患者场景只检索该患者的 facts,跨患者泄漏防护。
  const facts = (factProvider ?? new LegacyFactProvider(factsStore)).listCurrent({ patientHash: patientHash ?? undefined })
  for (const fact of facts) {
    const score = scoreText(`${fact.content} ${fact.category}`, queryTerms)
    if (score > 0) {
      results.push({
        kind: 'fact',
        source: fact.source || fact.factHash,
        content: fact.content,
        score,
        factHash: fact.factHash,
        category: fact.category,
        importance: fact.importance,
        stableId: fact.stableId,
      })
    }
  }

  for (const summary of knowledgeStore.all()) {
    const score = scoreText(`${summary.title} ${summary.content}`, queryTerms)
    if (score > 0) {
      results.push({
        kind: 'knowledge',
        source: `knowledge:${summary.id}`,
        content: `${summary.title}: ${summary.content.slice(0, 200)}`,
        score,
        // #748: summary legacy id === graph stableId — same fusion key rule.
        stableId: summary.id,
      })
    }
  }

  return results.sort((a, b) => b.score - a.score)
}
