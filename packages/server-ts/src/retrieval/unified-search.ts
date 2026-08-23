/**
 * #632 — 统一检索层:keyword(词法路) + vector(向量路) → RRF 融合 → Top-K。
 *
 * 词法精确词(MTX 25mg / EGFR-TKI)走 keywordSearch 不掉;paraphrase 语义
 * 相关命中走 embedding 余弦。embedding 服务故障时自动回落纯词法。
 * 双 store(facts/knowledge 词法 vs graph/document 向量)在此收敛。
 */
import { keywordSearch } from '../modules/knowledge/knowledge-command-handler.js'
import type { FactsStore, KnowledgeStore } from '../evolution/stores.js'
import { rrfFusion, type RrfCandidate } from './rrf-fusion.js'
import type { EmbeddingService } from '../memory/embedding/embedding.service.js'
import type { MemoryScope } from '../memory/contracts.js'

export interface UnifiedHit {
  content: string
  kind: 'fact' | 'knowledge' | 'document'
  source: string
  score: number
  factHash?: string
  category?: string
  importance?: number
}

export interface UnifiedSearchOptions {
  /** 向量路来源;缺省或故障时回落纯词法。 */
  embedding?: EmbeddingService
  patientHash?: string | null
  topK?: number
  /** keyword 路的分数阈值(与 keywordSearch 语义一致,默认 1)。 */
  minScore?: number
  includeCrossPatient?: boolean
}

/**
 * 统一检索:keyword + vector 双路 RRF 融合。
 * 词法命中带 factHash/category/importance(注入层去重与渲染用);
 * 向量独有命中(document/图谱节点)标注对应 kind。
 */
export async function unifiedSearch(
  query: string,
  facts: FactsStore,
  knowledge: KnowledgeStore,
  opts: UnifiedSearchOptions = {},
): Promise<UnifiedHit[]> {
  const topK = opts.topK ?? 5
  const minScore = opts.minScore ?? 1
  const scope: MemoryScope = { patientHash: opts.patientHash ?? undefined }
  if (query.trim().length === 0) return []

  const keywordHits = keywordSearch(query, facts, knowledge, undefined, opts.patientHash)
    .filter((r) => r.score >= minScore)
    .slice(0, topK * 2)

  const keywordCandidates: RrfCandidate[] = keywordHits.map((r, i) => ({
    content: r.content,
    source: 'keyword',
    sourceId: r.source,
    rank: i + 1,
  }))

  let vectorCandidates: RrfCandidate[] = []
  const vecTypeById = new Map<string, string>()
  if (opts.embedding) {
    try {
      const vecHits = await opts.embedding.retrieve(query, scope, {
        topK: topK * 2,
        minScore: 0.25,
        includeCrossPatient: opts.includeCrossPatient,
      })
      for (const h of vecHits) vecTypeById.set(h.stableId, h.type)
      vectorCandidates = vecHits.map((h, i) => ({
        content: h.content,
        source: 'vector',
        sourceId: h.stableId,
        rank: i + 1,
      }))
    } catch {
      // embedding 服务故障 → 词法路兜底
    }
  }

  const merged = rrfFusion([keywordCandidates, vectorCandidates], topK)
  const keywordById = new Map(keywordHits.map((r) => [r.source, r]))

  const hits: UnifiedHit[] = []
  for (const m of merged) {
    const kw = keywordById.get(m.sourceIds[0])
    if (kw) {
      hits.push({
        content: m.content,
        kind: kw.kind,
        source: kw.source,
        score: m.score,
        factHash: kw.factHash,
        category: kw.category,
        importance: kw.importance,
      })
    } else {
      // 向量独有命中 — 按 embedding 记录的 type 标注(graph fact/article/document)
      const vtype = vecTypeById.get(m.sourceIds[0])
      hits.push({
        content: m.content,
        kind: vtype === 'fact' ? 'fact' : vtype === 'article' ? 'knowledge' : 'document',
        source: m.sourceIds[0],
        score: m.score,
      })
    }
  }
  return hits
}
