/**
 * #852/#849 — 动态富化层:OpenAlex/DOAJ 按需补充 seed 快照。
 * 原则:外部源不可达 → 静默回落 seed 值(推荐链永不阻塞);
 * 动态值成功取得时覆盖 metrics 并标 source/asOf(D2 可回查)。
 */
import type { JournalRecord, Recommendation } from './journal-types.js'
import { fetchOpenAlexSource, fetchOpenAlexTypeDistribution, fetchOpenAlexSimilarWorks, extractSearchTerms } from './openalex.client.js'
import { fetchDoajJournal } from './doaj.client.js'

const ENRICH_TIMEOUT_MS = 8000

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ])
}

/** 单刊富化:openalex source + 近两年类型分布 + 同类文章 + DOAJ APC。任一失败保留 seed 值。 */
export async function enrichJournal(record: JournalRecord, similarTo?: string): Promise<JournalRecord> {
  if (process.env.JOURNAL_DYNAMIC_DATA === 'off') return record
  const enriched: JournalRecord = structuredClone(record)
  // 无 ISSN 的刊走刊名精确匹配兜底(OpenAlex display_name.search)
  const [source, doaj] = await Promise.all([
    withTimeout(fetchOpenAlexSource(record.issn, record.name), ENRICH_TIMEOUT_MS),
    record.issn ? withTimeout(fetchDoajJournal(record.issn), ENRICH_TIMEOUT_MS) : Promise.resolve(null),
  ])
  if (source) {
    enriched.metrics.openAlex = {
      hIndex: source.hIndex ?? 0,
      worksCount: source.worksCount ?? 0,
      oaRatio: source.oaRatio,
      asOf: source.asOf,
      source: 'openalex',
    }
    // 近两年文章类型分布(breakdown articleType 维度的真值来源)
    const dist = await withTimeout(fetchOpenAlexTypeDistribution(source.openAlexId), ENRICH_TIMEOUT_MS)
    if (dist) {
      enriched.metrics.articleTypeDistribution = {
        value: dist.types.map((t) => ({ type: t.type, share: t.share })),
        asOf: dist.asOf,
        source: 'openalex',
      }
    }
    // 同类文章证据(方案1):该刊近两年与稿件最相似的工作
    if (similarTo && similarTo.trim()) {
      const similar = await withTimeout(
        fetchOpenAlexSimilarWorks(source.openAlexId, extractSearchTerms(similarTo)),
        ENRICH_TIMEOUT_MS,
      )
      if (similar && similar.length > 0) enriched.similarWorks = similar
    }
  }
  if (doaj?.inDoaj) {
    enriched.metrics.apc = doaj.apc
      ? { value: doaj.apc.value, currency: doaj.apc.currency, asOf: doaj.asOf, source: 'doaj' }
      : enriched.metrics.apc
  }
  return enriched
}

/** 推荐结果批量富化(picks 上限 9 本,外呼有界);similarTo = 稿件标题(同类文章证据)。 */
export async function enrichRecommendations(recs: Recommendation[], similarTo?: string): Promise<Recommendation[]> {
  const enriched = await Promise.all(recs.map(async (rec) => ({ ...rec, journal: await enrichJournal(rec.journal, similarTo) })))
  return enriched
}
