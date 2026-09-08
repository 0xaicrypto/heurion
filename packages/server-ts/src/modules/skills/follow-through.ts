/**
 * #841 环⑤ — 遵循度度量(设计 §3.5,闭环的闭环)。
 *
 * 遵循判定(零 LLM):
 *  - generate/command 类:激活回合的实际工具序列与剧本声明的工具序列
 *    (meta.toolsSequence,归纳时从聚类指纹带出)做子序列包含比对;
 *  - edit 类(D5 产出物判定):是否完成剧本声明的产出 — v1 简化为
 *    docEdits ≥ 1(剧本来自写作/编辑流程)。
 *
 * telemetry 四事件(telemetry.service 既有基建):skill_activated /
 * skill_followed / skill_ignored / skill_task_outcome。
 *
 * 自动降级:滑动窗口(最近 10 次激活)followRate < 0.4 → lifecycle='suspended'
 * **降级不删除** — 医生重审(refine #298 保留)后可恢复 active。
 */
import type { MemoryService } from '../../memory/memory.service.js'
import { PrismaTelemetryService } from '../knowledge/telemetry.service.js'
import { makeLogger } from '../../common/logger.js'

const log = makeLogger('skills.follow-through')
const telemetry = new PrismaTelemetryService()

const WINDOW = 10
const SUSPEND_THRESHOLD = 0.4

/** 子序列包含:declared 按顺序出现在 actual 中(不必连续)即算遵循。 */
export function sequenceContains(actual: string[], declared: string[]): boolean {
  if (declared.length === 0) return false
  let i = 0
  for (const a of actual) {
    if (a === declared[i]) i++
    if (i >= declared.length) return true
  }
  return i >= declared.length
}

/** 单次激活的遵循判定(纯函数)。 */
export function judgeFollowed(
  node: Record<string, any>,
  turn: { toolsUsed: string[]; docEdits: number },
): boolean {
  const declared = Array.isArray(node.meta?.toolsSequence) ? node.meta.toolsSequence.map(String) : []
  if (declared.length > 0) return sequenceContains(turn.toolsUsed, declared)
  // 无工具序列声明(capture 来源)→ D5 产出物判定:编辑类回合完成了写回。
  return turn.docEdits >= 1
}

export interface FollowThroughInput {
  memory: MemoryService
  userId: string
  /** 本轮激活的剧本卡(matchSkillsForTurn 输出)— stableId 精确关联,缺省回落 name。 */
  activated: Array<{ name: string; stableId?: string }>
  toolsUsed: string[]
  docEdits: number
  outcome: 'completed' | 'abandoned'
}

/**
 * 回合终了:逐激活 skill 记录遵循/忽略,维护滑动窗口 followRate,
 * 达降级线自动 suspended(不删除)。
 */
export async function recordFollowThrough(input: FollowThroughInput): Promise<void> {
  const activatedIds = new Set(input.activated.map((s) => s.stableId).filter(Boolean) as string[])
  const activatedNames = new Set(
    input.activated.filter((s) => !s.stableId || !activatedIds.has(s.stableId)).map((s) => s.name),
  )
  if (activatedIds.size === 0 && activatedNames.size === 0) return
  const nodes = (input.memory.graph.getCurrentNodesByType('skill') ?? []) as any[]
  let mutated = false

  for (const node of nodes) {
    // 优先 stableId 精确匹配;卡片缺 stableId(legacy)回落 name
    if (!(activatedIds.has(node.stableId) || (activatedNames.has(node.name) && !activatedIds.has(node.stableId)))) continue

    mutated = true

    // skill_activated(每次激活可回放,审计要求 §5)
    await telemetry.record({
      userId: input.userId,
      workspaceId: input.userId,
      category: 'skill',
      action: 'skill_activated',
      metadata: { skillId: node.stableId, name: node.name },
    }).catch(() => {})

    const followed = judgeFollowed(node, { toolsUsed: input.toolsUsed, docEdits: input.docEdits })

    // skill_followed / skill_ignored
    await telemetry.record({
      userId: input.userId,
      workspaceId: input.userId,
      category: 'skill',
      action: followed ? 'skill_followed' : 'skill_ignored',
      metadata: { skillId: node.stableId, name: node.name },
    }).catch(() => {})

    // 统计 + 滑动窗口维护
    const recent: boolean[] = Array.isArray(node.meta?.recentOutcomes) ? [...node.meta.recentOutcomes] : []
    recent.push(followed)
    while (recent.length > WINDOW) recent.shift()
    const followRate = recent.length > 0 ? recent.reduce((a, b) => a + (b ? 1 : 0), 0) / recent.length : 0

    node.taskCount = (node.taskCount ?? 0) + 1
    if (followed) node.successCount = (node.successCount ?? 0) + 1
    else node.failureCount = (node.failureCount ?? 0) + 1
    node.followRate = Number(followRate.toFixed(2))
    node.meta = { ...(node.meta || {}), recentOutcomes: recent }
    node.updatedAt = Date.now()

    // 自动降级(仅新数据足够时判定;降级不删除,重审可恢复)
    if (recent.length >= WINDOW && followRate < SUSPEND_THRESHOLD && node.lifecycle === 'active') {
      node.lifecycle = 'suspended'
      await telemetry.record({
        userId: input.userId,
        workspaceId: input.userId,
        category: 'skill',
        action: 'skill_suspended',
        metadata: { skillId: node.stableId, followRate: node.followRate, window: recent.length },
      }).catch(() => {})
      log.warn('[follow-through] auto-suspended', { skill: node.name, followRate: node.followRate })
    }
  }

  // #912: 回合内的 taskCount/followRate/lifecycle 变更持久化 —
  // MemoryGraph 仅显式 commit 落盘(memory.graph.ts),不 commit 则重启后
  // 统计蒸发。走与 fact 写路相同的 graph.commit() 通道;commit
  // 失败由调用方(post-turn best-effort 段)吞掉,不阻断回合。
  if (mutated) input.memory.graph.commit()

  // skill_task_outcome(回合级,success/abandoned)
  await telemetry.record({
    userId: input.userId,
    workspaceId: input.userId,
    category: 'skill',
    action: 'skill_task_outcome',
    metadata: { outcome: input.outcome, toolsUsed: input.toolsUsed.slice(0, 20), docEdits: input.docEdits },
  }).catch(() => {})
}
