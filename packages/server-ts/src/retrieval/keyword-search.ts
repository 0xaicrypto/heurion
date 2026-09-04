/**
 * #666-followup: keyword search over Facts + Knowledge stores — moved out of
 * knowledge-command-handler so `retrieval/` never imports `modules/*`
 * (unified-search used it, creating a retrieval→knowledge→retrieval cycle).
 */
import { FactsStore, KnowledgeStore } from '../evolution/stores.js'
import { LegacyFactProvider, GraphFactProvider, type FactProvider } from '../memory/fact-provider.js'

/** #840: graph 最小形状 — 避免 retrieval 层引入完整 MemoryGraph 类型依赖。 */
export interface GraphLike {
  getCurrentNodesByType(type: string): Array<Record<string, any>>
}

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

/** #841 环④: 激活匹配复用同一分词器(中英混排,短 token 过滤)。 */
export function tokenize(text: string): string[] {
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
  /** #840: graph 读路径 — 提供时 facts/summaries 均从 graph 取(单一事实源);缺省回落 legacy 投影。 */
  graph?: GraphLike,
): SearchResult[] {
  const queryTerms = tokenize(query)
  if (queryTerms.length === 0) return []

  const results: SearchResult[] = []

  // #840: 默认反转 — 传 graph 时 facts 走 GraphFactProvider(graph 单一事实源),
  // 未传时回落 legacy 适配器(投影缓存)。显式传 provider 时按同一接口访问。
  // #629: patientHash 过滤 — 患者场景只检索该患者的 facts,跨患者泄漏防护。
  const facts = (factProvider ?? (graph ? new GraphFactProvider(graph as any) : new LegacyFactProvider(factsStore)))
    .listCurrent({ patientHash: patientHash ?? undefined })
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

  // #840: summaries 同批切换 — graph 提供时从 graph summary 节点取(legacy
  // KnowledgeStore 仅作缺省回落)。
  const summaries: Array<{ id: string; title: string; content: string }> = graph
    ? (graph.getCurrentNodesByType('summary') as Array<Record<string, any>>)
        .map((n) => ({ id: String(n.stableId), title: String(n.title || ''), content: String(n.content || '') }))
    : knowledgeStore.all()
  for (const summary of summaries) {
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
