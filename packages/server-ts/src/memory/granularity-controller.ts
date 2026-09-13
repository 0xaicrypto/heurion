/**
 * #1013（SECOND_BRAIN Phase A）— 颗粒度决策集中点（零行为重构）。
 *
 * 把散落三处的现有规则**原样**收敛为唯一决策入口，调用方不再内联判断：
 *   - 情景边界（`memory/compaction/runner.ts`）：
 *       extract_segment 片段 ≥ MIN_EXTRACT_EVENTS；compaction_segment ≥ MIN_COMPACT_EVENTS
 *   - 语义合成（`memory/knowledge-synthesis.ts` #816 覆盖率驱动）：
 *       scoped / unused / 最大类目簇均 ≥ SUMMARY_MIN_CLUSTER
 *   - 知识缺口检测（`modules/knowledge/knowledge-gap.service.ts` K6）：
 *       问题形 + 未被现有事实覆盖 + 长度 > GAP_MIN_MESSAGE_CHARS → 升级为 gap
 *
 * Phase F（#1018）会把内部规则替换为基于 MemoryUsageBus 的自适应策略 —
 * 届时只需改本组件，调用方签名不变。shouldDemote 当前无既有规则（降级
 * 策略属于 Phase F），保留接口并返回 false。
 */
import { MIN_COMPACT_EVENTS, MIN_EXTRACT_EVENTS } from './compaction/budget.js'

export type MemoryTier = 'episodic' | 'semantic' | 'procedural' | 'reference'

/** 语义合成最小簇（#816：类目内未覆盖 facts ≥ 该值才合成）。 */
export const SUMMARY_MIN_CLUSTER = 3
/** 缺口检测最短消息长度（K6，> 该值才算可研究的问题）。 */
export const GAP_MIN_MESSAGE_CHARS = 5

export interface ConsolidateCandidate {
  kind: 'extract_segment' | 'compaction_segment' | 'summary_synthesis'
  /** extract_segment / compaction_segment：片段内消息事件数。 */
  eventCount?: number
  /** summary_synthesis：scope 内 facts 数。 */
  scopedCount?: number
  /** summary_synthesis：未被现有/pending summary 覆盖的 facts 数。 */
  unusedCount?: number
  /** summary_synthesis：最大类目簇大小。 */
  bestClusterCount?: number
}

export interface PromoteCandidate {
  kind: 'gap'
  /** 现有事实关键词覆盖 → 已覆盖则不缺口。 */
  covered?: boolean
  /** 问题形消息（gap-detect.detectQuestionShaped）。 */
  questionShaped?: boolean
  messageLength?: number
}

/** 使用反馈（#1014 MemoryUsageBus 接入后填充；Phase A 仅保留类型）。 */
export interface UsageStats {
  uses?: number
  lastUsedAt?: number
  importance?: number
}

export class MemoryGranularityController {
  /** 是否应执行一次「巩固」（提取/压缩/合成）。tier 供 Phase F 分策略用。 */
  shouldConsolidate(_tier: MemoryTier, candidate: ConsolidateCandidate): boolean {
    switch (candidate.kind) {
      case 'extract_segment':
        return (candidate.eventCount ?? 0) >= MIN_EXTRACT_EVENTS
      case 'compaction_segment':
        return (candidate.eventCount ?? 0) >= MIN_COMPACT_EVENTS
      case 'summary_synthesis': {
        if (candidate.scopedCount !== undefined) return candidate.scopedCount >= SUMMARY_MIN_CLUSTER
        if (candidate.unusedCount !== undefined) return candidate.unusedCount >= SUMMARY_MIN_CLUSTER
        if (candidate.bestClusterCount !== undefined) return candidate.bestClusterCount >= SUMMARY_MIN_CLUSTER
        return false
      }
    }
  }

  /** 是否应把候选升级为正式待办/记忆（当前仅 K6 缺口检测）。 */
  shouldPromote(unit: PromoteCandidate, _usage?: UsageStats): boolean {
    if (unit.kind === 'gap') {
      return !unit.covered && Boolean(unit.questionShaped) && (unit.messageLength ?? 0) > GAP_MIN_MESSAGE_CHARS
    }
    return false
  }

  /** 是否应降级/折叠记忆单元 — Phase A 无既有规则（Phase F 接入使用数据）。 */
  shouldDemote(_unit: unknown, _usage?: UsageStats): boolean {
    return false
  }
}

/** 进程级单例 — 调用方统一从这里取。 */
export const memoryGranularity = new MemoryGranularityController()
