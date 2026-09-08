/**
 * #849/#850 — 选刊能力升级契约(JOURNAL_SELECTION_DESIGN.md v1.0 §3)。
 * 核心原则:D2 数据诚实性 — 专有指标一律带 asOf+source;D5 红线一等公民。
 *
 * 实施修订(2026-09-08,设计 §8 决策记录同步):apc 记录 DOAJ 返回的原币种
 * (value+currency),不做汇率换算 — 假装精确换算等于伪造数据。
 */

/** 指标值:数值 + 数据截至 + 来源(可回查)。 */
export interface DatedMetric<T = number> {
  value: T
  asOf: string
  source: string
}

export interface JournalMetrics {
  impactFactor?: DatedMetric
  casZone?: DatedMetric<string>
  sjr?: DatedMetric
  acceptanceRate?: DatedMetric
  reviewWeeksMedian?: DatedMetric
  apc?: { value: number; currency: string; asOf: string; source: 'doaj' | 'doaj_snapshot' }
  openAlex?: { hIndex: number; worksCount: number; oaRatio?: number; asOf: string; source: 'openalex' }
  articleTypeDistribution?: DatedMetric<Array<{ type: string; share: number }>>
}

export interface JournalWarning {
  kind: 'cas_warning_list' | 'predatory_signal'
  asOf: string
  note: string
}

export interface JournalRecord {
  id: string
  name: string
  issn?: string
  publisher?: string
  zhName?: string
  description?: string
  metrics: JournalMetrics
  scope: string[]
  keywords: string[]
  articleTypes: string[]
  /** 全 OA 刊(DOAJ 口径;APC 详情见 metrics.apc)。 */
  oa?: boolean
  guideUrl?: string
  /**
   * 同类文章证据(方案1,#852+):该刊近两年与稿件标题匹配的工作
   * (OpenAlex search = 标题+摘要+全文索引;动态拉取,非快照,无 profile 时缺省)。
   */
  similarWorks?: Array<{ title: string; year?: number; doi?: string; citedBy?: number }>
  warnings: JournalWarning[]
  logo: { monogram: string; color: string }
  freshness: { seed: boolean; updatedAt: string; stale: boolean }
}

/* ── ① 选题画像(SelectionProfile) ─────────────────────────────── */

export type ArticleTypeHint = 'rct' | 'cohort' | 'case_report' | 'review' | 'meta' | 'real_world'
export type SelectionPriority = 'impact' | 'speed' | 'acceptance'

export interface SelectionProfile {
  title: string
  abstract?: string
  articleType?: ArticleTypeHint | string
  priority?: SelectionPriority
  selfPayOa?: boolean
  language?: 'en' | 'zh'
}

/* ── ② 推荐(breakdown 结构化理由,D4) ─────────────────────────── */

export type ScoreDimension = 'scope' | 'articleType' | 'impact' | 'speed' | 'acceptance' | 'cost'

export interface BreakdownRow {
  dimension: ScoreDimension
  score: number
  evidence: string
}

export interface Recommendation {
  journal: JournalRecord
  tier: 'reach' | 'match' | 'safety'
  totalScore: number
  breakdown: BreakdownRow[]
}

export interface TieredRecommendation {
  engine: 'selection-v2'
  profileEcho: { priority: SelectionPriority; articleType?: string; selfPayOa: boolean }
  tiers: { reach: Recommendation[]; match: Recommendation[]; safety: Recommendation[] }
  redline: Array<{ journal: JournalRecord }>
}

/* ── ⑤ Guide for Authors(#851) ──────────────────────────────── */

export interface GuideRequirements {
  journalId: string
  journalName: string
  bodyWordLimit?: number
  abstractWordLimit?: number
  abstractStructure?: 'IMRaD' | 'structured' | 'unstructured'
  figureLimit?: number
  referenceStyle?: 'AMA' | 'Vancouver' | 'APA' | 'other'
  requiredStatements?: string[]
  confidence: 'high' | 'medium' | 'low'
  sourceUrl?: string
  fetchedAt: string
}

export type FetchGuideResult =
  | { ok: true; requirements: GuideRequirements }
  | { ok: false; reason: string; manualUrl?: string }

export interface PrecheckItem {
  id: string
  label: string
  ok: boolean | null            // null = 无法自动判定(人工核对)
  detail?: string
}
