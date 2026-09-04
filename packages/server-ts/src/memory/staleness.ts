/**
 * #813 — summary 失效判定的单一入口。
 *
 * `isSummaryStale`(纯谓词)此前生产零调用:curation.engine 用自己的
 * markStatus+getDependents 逻辑实现了等价判定,两套实现存在漂移风险 —
 * 事件路径会把"引用了编辑后新版本"的 summary 也误标 stale(它只是
 * 恰好挂在同一 stableId 的某个版本边上)。现在 curation 传播与注入侧
 * 标注统一收敛到 resolveSummaryStaleness,curation 事件路径只负责
 * 触发时机,判定本身以本模块为准。
 *
 * 兼容性:节点上的 `staleBecause` 保持裸 fact stableId 格式
 * (summary-view.service / legacy stores / web 按裸 id 反查图谱),
 * 机器可读的 `edited:/deleted:` 原因仅在查询时派生,不落盘。
 * 历史 key `article_superseded`(KB 更名前的产物)仅被跳过,不再产出。
 */
import type { MemoryGraph } from './memory.graph'
import { isSummaryStale, type SummaryNode } from './memory.types'

export interface SummaryStaleness {
  stale: boolean
  /**
   * 机器可读原因(查询时派生,非持久化):
   * `edited:<factStableId>`(引用版本已被编辑取代)/
   * `deleted:<factStableId>`(该 fact 已无存活版本)/
   * `summary_superseded` / 历史 `article_superseded` / 历史 staleBecause(裸 stableId)。
   */
  reasons: string[]
  /** 人工可读摘要(注入标注用),stale=false 时为空串。 */
  summary: string
}

/**
 * 从图谱状态推导 summary 是否过时 — 所有 stale 判定的唯一入口。
 * - status superseded → 过时(被新版本取代);
 * - 引用的 fact 版本已 superseded 且该 stableId 已无存活版本 → 过时(已删除);
 * - 引用的 fact 版本已 superseded 但存在更新版本 → 过时(依据已修订);
 * - status stale(历史事件路径已标记)→ 保持过时(不静默"复活")。
 * 判定核心委托给 isSummaryStale 纯谓词(生产接线)。
 */
export function resolveSummaryStaleness(
  graph: Pick<MemoryGraph, 'getNode' | 'getLatestByStableId'>,
  summary: SummaryNode,
): SummaryStaleness {
  if (summary.status === 'superseded') {
    return { stale: true, reasons: ['summary_superseded'], summary: '总结已被新版本取代' }
  }
  const derived: string[] = []
  const supersededStableIds: string[] = []
  for (const sf of summary.sourceFacts || []) {
    const cited = graph.getNode(sf.nodeId)
    const latest = graph.getLatestByStableId(sf.stableId)
    const latestGone = !latest || latest.status === 'superseded'
    const citedGone = cited?.status === 'superseded'
    if (latestGone || citedGone) {
      supersededStableIds.push(sf.stableId)
      derived.push(latestGone ? `deleted:${sf.stableId}` : `edited:${sf.stableId}`)
    }
  }
  const stale = summary.status === 'stale' || isSummaryStale(summary, supersededStableIds)
  if (!stale) return { stale: false, reasons: [], summary: '' }
  const reasons = Array.from(new Set([...derived, ...(summary.staleBecause || [])]))
  return { stale: true, reasons, summary: buildSummary(reasons) }
}

function buildSummary(reasons: string[]): string {
  const parts: string[] = []
  for (const r of reasons) {
    if (r === 'article_superseded' || r === 'summary_superseded') continue
    const [kind, id] = r.includes(':') ? [r.slice(0, r.indexOf(':')), r.slice(r.indexOf(':') + 1)] : ['legacy', r]
    if (kind === 'edited') parts.push(`${id} 已修订`)
    else if (kind === 'deleted') parts.push(`${id} 已删除`)
    else parts.push(`${id} 已失效`)
  }
  return parts.length > 0 ? parts.join('；') : '总结已被新版本取代'
}

export interface SummaryInjectMeta {
  title: string
  stale: boolean
  staleSummary?: string
  /** 源 facts 的置信度/来源摘要,如 `fact_x[0.9,patient] fact_y[0.7,chat]`;无源 facts 时为空。 */
  sourceSummary: string
}

/** 源 facts 摘要的最大条数,超出折叠为「等 N 条」。 */
const SOURCE_SUMMARY_MAX = 5

/**
 * 注入侧的 summary 元数据描述(标题 + 源 facts 置信度/来源 + stale 标注)。
 * stableId 解析不到 summary 时返回 undefined,调用方回退原始渲染。
 */
export function describeSummaryForInjection(
  graph: Pick<MemoryGraph, 'getNode' | 'getLatestByStableId'>,
  summaryStableId: string,
): SummaryInjectMeta | undefined {
  const summary = graph.getLatestByStableId(summaryStableId)
  if (!summary || summary.type !== 'summary') return undefined
  const node = summary as SummaryNode
  const staleness = resolveSummaryStaleness(graph, node)
  const parts: string[] = []
  for (const sf of (node.sourceFacts || []).slice(0, SOURCE_SUMMARY_MAX)) {
    const fact = graph.getLatestByStableId(sf.stableId)
    const conf = (fact as { confidence?: number } | undefined)?.confidence
    const src = (fact as { sourceType?: string } | undefined)?.sourceType
    parts.push(`${sf.stableId}[${typeof conf === 'number' ? conf.toFixed(1) : '?'},${src || 'general'}]`)
  }
  const total = (node.sourceFacts || []).length
  if (total > SOURCE_SUMMARY_MAX) parts.push(`等${total}条`)
  return {
    title: node.title,
    stale: staleness.stale,
    staleSummary: staleness.stale ? staleness.summary : undefined,
    sourceSummary: parts.join(' '),
  }
}
