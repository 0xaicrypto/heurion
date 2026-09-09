/**
 * #841 环④ — Layer 4 按需激活(设计 §3.4)。
 *
 * 旧模式:skills 有就全量注入(memory-projection 截前 N)。v2:trigger 匹配
 * 按需激活 — 匹配函数**零 LLM**:
 *  1. taskKind 相等(intent-router 本轮判定,复用 TurnIntent 信号);
 *  2. triggers 关键词与本轮 query/scene 上下文倒排匹配(≥1 命中);
 *  3. intent 判定 uncertain / 非任务型回合(answer)→ 不激活(宁缺勿错注)。
 *
 * 命中 → 注入剧本卡摘要(≤3 条,name + description + followRate);模型认为
 * 相关再 load_skill 拉全剧本。无命中 → 索引为空,零 token 消耗。
 */
import { tokenize } from '../../retrieval/keyword-search.js'

/** 剧本卡摘要 — Layer 4 注入形状(设计 §3.4)。 */
export interface SkillCardSummary {
  name: string
  /** #840-r5: 稳定 ID — 遵循度度量按此精确关联(重名技能不再有歧义)。 */
  stableId?: string
  taskKind: string
  description: string
  followRate: number
}

/** graph SkillNode / legacy LearnedSkill 的最小读取形状。 */
export interface SkillLike {
  name: string
  /** #840-r5 稳定 ID(graph SkillNode 必有;legacy 卡片可缺)。 */
  stableId?: string
  taskKind: string
  description?: string
  bestStrategy?: string
  followRate?: number
  successCount?: number
  taskCount?: number
  triggers?: string[]
  lifecycle?: string
}

export interface MatchSkillsInput {
  skills: SkillLike[]
  /** 本轮 intent 判定的动作;answer(纯对话)传空 → 不激活。 */
  taskKind: string
  /** query + scene + 文档名等本轮上下文文本。 */
  queryText: string
  /** intent uncertain(needsClarify/veto)→ 本轮不激活。 */
  uncertain?: boolean
  max?: number
}

/** 零 LLM 激活匹配:taskKind 相等 ∧ triggers 倒排命中 ≥1。 */
export function matchSkillsForTurn(input: MatchSkillsInput): SkillCardSummary[] {
  const max = input.max ?? 3
  if (input.uncertain || !input.taskKind) return []
  const tokens = tokenize(input.queryText)
  if (tokens.length === 0) return []

  const matched: SkillCardSummary[] = []
  for (const s of input.skills) {
    // 降级/退役的一等状态:不激活(§3.5 降级不删除)
    if (s.lifecycle && s.lifecycle !== 'active') continue
    // 环① 对齐:仅任务型动作匹配(taskKind 相等,零额外 LLM)
    if (s.taskKind !== input.taskKind) continue
    const triggers = (Array.isArray(s.triggers) && s.triggers.length > 0 ? s.triggers : [s.name])
      .map((t) => String(t).toLowerCase())
    // 倒排匹配:任一 trigger 与任一上下文 token 双向包含(短 token 防误报)
    const hit = triggers.some((tr) =>
      tokens.some((tok) => (tr.includes(tok) || tok.includes(tr)) && (tok.length >= 2 || tr.length >= 2)))
    if (!hit) continue
    const followRate = typeof s.followRate === 'number'
      ? s.followRate
      : (s.taskCount ?? 0) > 0 ? (s.successCount ?? 0) / (s.taskCount ?? 1) : 0
    matched.push({
      name: s.name,
      stableId: s.stableId,
      taskKind: s.taskKind,
      description: s.description || s.bestStrategy || '',
      followRate,
    })
  }
  return matched.slice(0, max)
}
