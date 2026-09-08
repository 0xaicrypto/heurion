/**
 * #852 — OpenAlex sources client:按 ISSN 取期刊画像
 * (h-index/works_count/OA 状态/topics 分布),并支持按刊取近两年
 * 文章类型分布(“这本刊近两年接收回顾性研究占比” — 竞品缺位的维度)。
 * 数据面走 #835 externalRequest(per-host 节流 + 24h 缓存 + polite pool)。
 */
import { externalRequest, ExternalHttpError } from '../../tools/external-fetch.js'

export interface OpenAlexTopic {
  name: string
  count: number
  share: number
}

export interface OpenAlexSourceStats {
  openAlexId: string
  issn?: string
  name: string
  hIndex?: number
  worksCount?: number
  /** 真实 OA 占比 = oa_works_count / works_count(OpenAlex 官方口径)。 */
  oaRatio?: number
  topics: OpenAlexTopic[]
  asOf: string
}

export interface OpenAlexTypeDistribution {
  openAlexId: string
  windowYears: 2
  types: Array<{ type: string; count: number; share: number }>
  asOf: string
}

// 2026-09-08 实测对齐:open_access 不是 source 合法 select 字段;
// OA 占比用 is_oa/oa_works_count 真值计算(非 gold 状态推断)。
const SOURCE_SELECT = 'id,issn,display_name,works_count,cited_by_count,summary_stats,is_oa,oa_works_count,topics'

interface RawSource {
  id?: string
  issn?: string[]
  display_name?: string
  works_count?: number
  cited_by_count?: number
  summary_stats?: { h_index?: number; i10_index?: number; '2yr_mean_citedness'?: number }
  is_oa?: boolean
  oa_works_count?: number
  topics?: Array<{ display_name?: string; count?: number }>
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function parseSource(data: RawSource): OpenAlexSourceStats | null {
  if (!data?.id) return null
  const topics = (data.topics ?? [])
    .map((t) => ({ name: String(t.display_name ?? ''), count: Number(t.count ?? 0) }))
    .filter((t) => t.name && t.count > 0)
  const total = topics.reduce((sum, t) => sum + t.count, 0)
  return {
    openAlexId: data.id.replace('https://openalex.org/', ''),
    issn: data.issn?.[0],
    name: String(data.display_name ?? ''),
    hIndex: data.summary_stats?.h_index,
    worksCount: data.works_count,
    oaRatio: data.works_count && data.works_count > 0 ? (data.oa_works_count ?? 0) / data.works_count : undefined,
    topics: topics
      .map((t) => ({ ...t, share: total > 0 ? t.count / total : 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    asOf: today(),
  }
}

/** 全文检索兜底:无 ISSN 时按刊名精确匹配(display_name.search)。 */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').trim()
}

/**
 * 按 ISSN 查 OpenAlex source;无 ISSN 时按刊名精确匹配兜底(seed 中低置信 ISSN 刊)。
 * 404(未收录)与名称无精确命中 → null;网络/限流错误向上抛,
 * 由调用方(repository enrich)兜底 seed 快照 — OpenAlex 不可达不阻塞推荐链。
 */
export async function fetchOpenAlexSource(issn: string | undefined, name?: string): Promise<OpenAlexSourceStats | null> {
  if (issn) {
    const raw = await externalRequest('openalex', `/sources/issn:${issn}`, { select: SOURCE_SELECT })
    return parseSource(JSON.parse(raw) as RawSource)
  }
  if (name && name.trim()) {
    const raw = await externalRequest('openalex', '/sources', {
      filter: `display_name.search:${name.trim()}`,
      per_page: '5',
      select: SOURCE_SELECT,
    })
    const data = JSON.parse(raw) as { results?: RawSource[] }
    const exact = (data.results ?? []).find((r) => r.display_name && normalizeName(r.display_name) === normalizeName(name))
    return exact ? parseSource(exact) : null
  }
  return null
}

/**
 * 近两年该刊文章类型分布(group_by=type)。
 * “同类文章占比”供 breakdown 的 articleType 维度引用。
 * 2026-09-08 实测对齐:key 为类型 URI(https://openalex.org/types/article),取尾 slug。
 */
export async function fetchOpenAlexTypeDistribution(openAlexId: string): Promise<OpenAlexTypeDistribution | null> {
  const year = new Date().getUTCFullYear()
  const raw = await externalRequest('openalex', '/works', {
    filter: `primary_location.source.id:${openAlexId},publication_year:${year - 1}|${year}`,
    group_by: 'type',
  })
  const data = JSON.parse(raw) as { group_by?: Array<{ key?: string; key_display_name?: string; count?: number }> }
  const typeSlug = (g: { key?: string; key_display_name?: string }): string => {
    const key = String(g.key ?? '')
    if (key.startsWith('http')) return key.split('/').pop() ?? ''
    return (key || String(g.key_display_name ?? '')).toLowerCase()
  }
  const rows = (data.group_by ?? [])
    .map((g) => ({ type: typeSlug(g), count: Number(g.count ?? 0) }))
    .filter((r) => r.type && r.count > 0)
  const total = rows.reduce((sum, r) => sum + r.count, 0)
  if (total === 0) return null
  return {
    openAlexId,
    windowYears: 2,
    types: rows
      .map((r) => ({ ...r, share: r.count / total }))
      .sort((a, b) => b.count - a.count),
    asOf: today(),
  }
}

/** OpenAlex 是否 404(未收录)而非网络故障 — 用于静默降级分支。 */
export function isOpenAlexNotFound(err: unknown): boolean {
  return err instanceof ExternalHttpError && err.label === 'OpenAlex' && err.status === 404
}

/* ── 同类文章检索(方案 1:选刊证据)────────────────────────────── */

export interface OpenAlexSimilarWork {
  openAlexId: string
  title: string
  year?: number
  doi?: string
  citedBy?: number
}

interface RawWork {
  id?: string
  doi?: string
  display_name?: string
  title?: string
  publication_year?: number
  cited_by_count?: number
}

/**
 * 在目标刊近两年(含当年)范围内用稿件标题做 search 检索
 * (OpenAlex search = 标题 + 摘要 + 全文倒排索引),返回最相关的几篇 —
 * 回答“这本刊发过类似工作吗”的 breakdown 证据。
 */
export async function fetchOpenAlexSimilarWorks(
  openAlexId: string,
  manuscriptTitle: string,
  perPage = 3,
): Promise<OpenAlexSimilarWork[]> {
  const year = new Date().getUTCFullYear()
  const raw = await externalRequest('openalex', '/works', {
    filter: `primary_location.source.id:${openAlexId},publication_year:${year - 2}|${year}`,
    search: manuscriptTitle.slice(0, 200),
    per_page: String(perPage),
    select: 'id,doi,display_name,publication_year,cited_by_count',
  })
  const data = JSON.parse(raw) as { results?: RawWork[] }
  return (data.results ?? [])
    .filter((w) => w.id && (w.display_name || w.title))
    .map((w) => ({
      openAlexId: w.id!.replace('https://openalex.org/', ''),
      title: String(w.display_name ?? w.title ?? ''),
      year: w.publication_year,
      doi: w.doi ? w.doi.replace('https://doi.org/', '') : undefined,
      citedBy: w.cited_by_count,
    }))
}

/**
 * 从稿件标题提取检索词:去标点、取前 N 个有意义词
 * (全句搜会因功能词稀释相关性;短查询召回更稳)。
 */
export function extractSearchTerms(title: string, maxWords = 10): string {
  const words = title
    .replace(/["'()\[\]{}:;,.!?]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1)
  return words.slice(0, maxWords).join(' ').trim()
}
