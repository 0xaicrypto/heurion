/**
 * Submission wire contracts (#916) — journal-selection DTOs shared by
 * server-ts (producer: submission.router.ts serializes its camelCase domain
 * model into these shapes) and web (consumer: routes/submission.tsx).
 *
 * Single source of truth: web previously hand-mirrored these in
 * lib/types.ts and could drift from the actual wire. Field names are
 * snake_case and mirror the wire format EXACTLY — the camelCase domain
 * model (JournalRecord / TieredRecommendation) stays server-internal in
 * server-ts journal-types.ts.
 */

/** 指标值:数值 + 数据截至 + 来源(可回查;D2 数据诚实性)。 */
export interface DatedMetricDto<T = number> {
  value: T
  asOf: string
  source: string
}

export interface JournalWarningDto {
  kind: 'cas_warning_list' | 'predatory_signal'
  asOf: string
  note: string
}

export interface JournalMetricsDto {
  impact_factor: DatedMetricDto | null
  cas_zone: DatedMetricDto<string> | null
  acceptance_rate: DatedMetricDto | null
  review_weeks_median: DatedMetricDto | null
  apc: { value: number; currency: string; asOf: string; source: string } | null
  open_alex: { hIndex: number; worksCount: number; oaRatio?: number; asOf: string; source: string } | null
  article_type_distribution: DatedMetricDto<Array<{ type: string; share: number }>> | null
}

export interface JournalRecordDto {
  id: string
  name: string
  issn: string | null
  publisher: string | null
  zh_name: string | null
  description: string | null
  metrics: JournalMetricsDto
  scope: string[]
  article_types: string[]
  /** 全 OA 刊(DOAJ 口径;APC 详情见 metrics.apc)。 */
  oa: boolean
  guide_url: string | null
  /**
   * #852: 该刊近两年与稿件标题匹配的同类工作(OpenAlex 动态富化,
   * 非快照 — 无富化时缺省为 null)。
   */
  similar_works: Array<{ title: string; year?: number; doi?: string; citedBy?: number }> | null
  warnings: JournalWarningDto[]
  logo: { monogram: string; color: string }
  freshness: { seed: boolean; updatedAt: string; stale: boolean }
}

/** D4:结构化推荐理由行(按权重 × 分数降序;scope 恒在)。 */
export interface BreakdownRowDto {
  dimension: 'scope' | 'articleType' | 'impact' | 'speed' | 'acceptance' | 'cost'
  score: number
  evidence: string
}

/** 单档位推荐条目(名称沿用 #848 前端命名 — 一条 Recommendation 行)。 */
export interface TieredRecommendationDto {
  journal: JournalRecordDto
  tier: 'reach' | 'match' | 'safety'
  total_score: number
  breakdown: BreakdownRowDto[]
}

/** POST /api/v1/submission/recommend-journals 响应(三档梯度 + 红线区)。 */
export interface RecommendJournalsResult {
  engine: string
  profile_echo: { priority: 'impact' | 'speed' | 'acceptance'; article_type: string | null; self_pay_oa: boolean }
  tiers: { reach: TieredRecommendationDto[]; match: TieredRecommendationDto[]; safety: TieredRecommendationDto[] }
  redline: JournalRecordDto[]
  warning_list_asof: string | null
}
