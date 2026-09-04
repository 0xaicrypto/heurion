/**
 * Memory Projection — 上下文压缩与加权注意力
 *
 * 核心问题: 医生与 Agent 聊了 30 天、500 轮对话，LLM 上下文窗口有限。
 * 如何选择最相关、最重要的上下文注入当前轮次的 system prompt？
 *
 * 策略: 三层衰减 + 重要性加权
 *
 * (#634) Layer 1 — 最近 N 轮对话全文 已删除:
 *   与 conversation-turn 的 historyMessages 完全重复（同一批事件以
 *   两种形式各出现一次）。最近对话由 historyMessages 承担
 *   (compaction.ts buildHistoryMessages, 20 轮 / MAX_HISTORY_TOKENS=32K)。
 *
 * Layer 2 — 摘要压缩 (中注意力)
 *   最近 7 天的会话摘要（Episode），每个 ~100 tokens
 *
 * Layer 3 — 事实提取 (低注意力但持久)
 *   所有 Facts，按 importance×recency 排序
 *   高重要性(5) 的旧事实 > 低重要性(1) 的新事实
 *
 * 注意力公式:
 *   attention_score(entry) = recency_weight × importance_multiplier
 *
 *   recency_weight = e^(-λ × days_ago)
 *      λ = 0.3 → 7天前约 12%, 30天前约 0.01%
 *
 *   importance_multiplier (仅 Facts, #627 收敛自 attention.ts):
 *      5 → 2.2x    (极高, 总是保留)
 *      4 → 1.9x
 *      3 → 1.6x    (基准)
 *      2 → 1.3x
 *      1 → 1.0x    (低重要性快速衰减)
 *
 * 预算分配 (假设 8000 token 上下文窗口):
 *   ┌────────────┬──────────┬─────────────────────┐
 *   │ 类别        │ Token  % │ 内容                 │
 *   ├────────────┼──────────┼─────────────────────┤
 *   │ System     │ 500   6% │ 人格 + 指令           │
 *   │ Patient    │ 1000  12% │ 当前患者临床图谱       │
 *   │ Layer 2    │ 1500  19% │ 最近 7 天 Episodes    │
 *   │ Layer 3    │ 1500  19% │ 高权重 Facts          │
 *   │ Skills     │ 500    6% │ 活跃技能列表           │
 *   │ Reserve    │ 500    6% │ 预留弹性               │
 *   └────────────┴──────────┴─────────────────────┘
 */

import { Fact, Episode, LearnedSkill } from '../evolution/stores'
import prisma from '../common/prisma'

// ── 配置 ────────────────────────────────────────────────

export interface ProjectionConfig {
  maxTokens: number           // 上下文窗口大小 (token 估计)
  layer2EpisodeDays: number   // Episode 保留天数
  recencyLambda: number       // 衰减系数
  patientContextTokens: number
  reserveTokens: number
  /** #814: layer3 降级 — importance ≥ 此值或近 N 天才进入碎片投影。 */
  layer3ImportanceMin: number
  layer3RecentDays: number
}

const DEFAULT_CONFIG: ProjectionConfig = {
  maxTokens: CONTEXT_CONFIG.projection.maxTokens,
  layer2EpisodeDays: CONTEXT_CONFIG.projection.episodeDays,
  recencyLambda: CONTEXT_CONFIG.projection.recencyLambda,
  patientContextTokens: CONTEXT_CONFIG.projection.patientContextTokens,
  reserveTokens: CONTEXT_CONFIG.projection.reserveTokens,
  layer3ImportanceMin: CONTEXT_CONFIG.projection.layer3ImportanceMin,
  layer3RecentDays: CONTEXT_CONFIG.projection.layer3RecentDays,
}

// ── 注意力评分 ──────────────────────────────────────────

import { daysAgo, recencyWeight, importanceMultiplier } from '../common/attention.js' // §5.4 (#197)
import { estimateTokens } from '../common/token-estimate.js' // §5.4 (#197)
import { formatFactLine } from '../common/fact-render.js' // #627 统一渲染
import { CONTEXT_CONFIG } from '../common/context-config.js' // #637 集中配置
import { makeLogger } from '../common/logger.js'

const log = makeLogger('retrieval.memory-projection')

/**
 * #814: 身份级类目 — 与 persona 同源。全局范围的
 * preference/constraint/goal 已进 persona,layer3 不再重复注入
 * (persona.ts 注释声称的去重自此真实成立);患者范围的同类 facts
 * 不受影响(persona 按 §13.3A 只收全局,不会重复)。
 */
const PERSONA_IDENTITY_CATEGORIES = new Set(['preference', 'constraint', 'goal'])

// ── 上下文投影器 ───────────────────────────────────────

export class MemoryProjection {
  constructor(
    private config: ProjectionConfig = DEFAULT_CONFIG,
  ) {}

  /**
   * 为当前对话轮次投影上下文
   *
   * @returns 组装好的 system prompt 各部分，调用方决定如何拼接
   */
  async project(params: {
    userId: string
    patientHash: string | null
    persona: string
    facts: Fact[]
    episodes: Episode[]
    skills: LearnedSkill[]
  }): Promise<{
    systemPrompt: string
    /** R1 (#98): per-layer typed context segments for hash-diffing. */
    segments: Array<{ key: string; text: string }>
    budget: { layer: string; tokens: number; items: number }[]
  }> {
    const { maxTokens, patientContextTokens, reserveTokens } = this.config

    // ── Layer 0: System Persona (固定) ──
    const personaTokens = estimateTokens(params.persona)
    let remaining = maxTokens - personaTokens - reserveTokens

    // ── Layer 0b: Patient Context (高优先级) ──
    let patientContext = ''
    if (params.patientHash) {
      patientContext = await this.buildPatientContext(params.userId, params.patientHash)
    }
    const patientTokens = Math.min(estimateTokens(patientContext), patientContextTokens)
    remaining -= patientTokens

    // (#634) Layer 1 已删除 — 最近对话由 historyMessages 承担，此处不再注入。

    // ── Layer 2: 最近 N 天 Episodes (中注意力) ──
    const scoredEpisodes = params.episodes
      .map(ep => ({ episode: ep, score: recencyWeight(daysAgo(ep.createdAt), this.config.recencyLambda) }))
      .filter(s => s.score > 0.05) // 注意力低于 5% 的丢弃
      .sort((a, b) => b.score - a.score)

    let layer2Text = ''
    let layer2Count = 0
    const episodeBudget = Math.min(remaining * 0.4, CONTEXT_CONFIG.projection.episodesBudget)
    for (const se of scoredEpisodes) {
      const line = `[Day ${Math.round(daysAgo(se.episode.createdAt))}d ago] ${se.episode.summary}`
      const t = estimateTokens(line)
      if (estimateTokens(layer2Text) + t > episodeBudget) break
      layer2Text += line + '\n'
      layer2Count++
    }
    remaining -= estimateTokens(layer2Text)

    // ── Layer 3: 加权 Facts (importance × recency) ──
    // #627: 评分收敛 — 统一走 attention.ts 的 importanceMultiplier,
    // 不再手写 [0.25,0.5,1.0,1.5,2.0](5→2.0x vs attention 5→2.2x 曾矛盾)。
    // #814: layer3 降级为"未成文记忆" —
    //   ① 全局 preference/constraint/goal 已进 persona,此处排除(去重);
    //   ② 仅 importance ≥ 阈值或近 N 天的 facts 进入投影(长尾交给
    //      summary 覆盖 — 覆盖率调度见 #816,JIT 兜底见 #815)。
    let personaIdentityExcluded = 0
    let downgradedOut = 0
    const scoredFacts = params.facts
      .filter(f => {
        if (PERSONA_IDENTITY_CATEGORIES.has(f.category) && !f.patientHash && !f.studyId) {
          personaIdentityExcluded += 1
          return false
        }
        const recent = daysAgo(f.createdAt) <= this.config.layer3RecentDays
        if ((f.importance ?? 3) < this.config.layer3ImportanceMin && !recent) {
          downgradedOut += 1
          return false
        }
        return true
      })
      .map(f => {
        const score = recencyWeight(daysAgo(f.createdAt), this.config.recencyLambda) * importanceMultiplier(f.importance)
        return { fact: f, score }
      })
      .filter(s => s.score > 0.02)
      .sort((a, b) => b.score - a.score)

    let layer3Text = ''
    let layer3Count = 0
    const factsBudget = Math.min(remaining, CONTEXT_CONFIG.projection.factsBudget)
    for (const sf of scoredFacts) {
      const line = this.formatFact(sf.fact, sf.score)
      const t = estimateTokens(line)
      if (estimateTokens(layer3Text) + t > factsBudget) break
      layer3Text += line + '\n'
      layer3Count++
    }
    remaining -= estimateTokens(layer3Text)

    // #814: 注入条数/字符占比 telemetry — 供 summary-first 前后对比
    // (facts 裸注入占比是本 epic 的核心验收指标)。
    log.info('layer3 projection telemetry', {
      userId: params.userId,
      inputFacts: params.facts.length,
      injected: layer3Count,
      tokens: estimateTokens(layer3Text),
      chars: layer3Text.length,
      excludedPersonaIdentity: personaIdentityExcluded,
      downgradedOut,
    })

    // ── Layer 4: Skills (固定, 低开销) ──
    let skillsText = ''
    if (params.skills.length > 0) {
      skillsText = params.skills
        .filter(s => s.successCount > 0)
        .slice(0, CONTEXT_CONFIG.projection.skillsMax) // 最多 N 个技能
        .map(s => `- ${s.name}: ${s.bestStrategy} (${s.successCount}/${s.taskCount})`)
        .join('\n')
    }

    // ── 组装 ──
    // §4.3 (#188): 引用标注规则已并入 layer3 段头(#814 文案收敛)。
    const sections = [
      params.persona,
      patientContext ? `\n## Patient Context\n${patientContext}` : '',
      layer2Text ? `\n## Recent Sessions\n${layer2Text}` : '',
      // #814: 段文案明示碎片属性 — 模型优先参考知识库注入的总结,
      // 碎片仅作未成文记忆补充。§4.3 (#188) 引用标注规则保留(含示例)。
      layer3Text ? `\n## 未成文记忆(碎片)\n以下为尚未合成知识摘要的记忆碎片,可能已有摘要覆盖(以知识库注入为准)。引用记忆中的事实时请附带 [置信度, 来源],例如 [0.9, chat];不确定的记忆请标注 "不确定"。\n${layer3Text}` : '',
      skillsText ? `\n## Active Skills\n${skillsText}` : '',
    ].filter(Boolean)

    return {
      systemPrompt: sections.join('\n'),
      // R1 (#98): typed context segments — each layer maps to a stable
      // segment key so the chat pipeline can hash-snapshot them (provider
      // prompt-cache friendly) and diff changes between turns.
      segments: [
        { key: 'persona', text: params.persona },
        ...(patientContext ? [{ key: 'patient_context', text: patientContext }] : []),
        ...(layer2Text ? [{ key: 'recent_sessions', text: layer2Text }] : []),
        ...(layer3Text ? [{ key: 'accumulated_knowledge', text: layer3Text }] : []),
        ...(skillsText ? [{ key: 'active_skills', text: skillsText }] : []),
      ],
      budget: [
        { layer: 'persona', tokens: personaTokens, items: 1 },
        { layer: 'patient', tokens: patientTokens, items: params.patientHash ? 1 : 0 },
        { layer: 'layer2_episodes', tokens: estimateTokens(layer2Text), items: layer2Count },
        { layer: 'layer3_facts', tokens: estimateTokens(layer3Text), items: layer3Count },
        { layer: 'layer4_skills', tokens: estimateTokens(skillsText), items: params.skills.length },
        { layer: 'reserve', tokens: remaining, items: 0 },
      ],
    }
  }

  // ── 患者上下文 (从临床图谱获取) ──

  private async buildPatientContext(userId: string, patientHash: string): Promise<string> {
    try {
      // Try clinical_graph_nodes first (may not exist)
      let nodes: Array<{ node_type: string; content_json: string; weight: number; updated_at: number }> | null = null
      try {
        nodes = await (prisma as any).$queryRawUnsafe(
          `SELECT node_type, content_json, weight, updated_at
           FROM clinical_graph_nodes
           WHERE user_id = ? AND patient_hash = ?
           ORDER BY weight DESC LIMIT 25`,
          userId, patientHash
        )
      } catch { /* table may not exist */ }

      // Fallback: read from patient_records
      let patientBasicInfo = ''
      if (!nodes || !nodes.length) {
        const patient = await (prisma as any).patientRecord.findFirst({
          where: { hash: patientHash, userId },
        })
        if (patient) {
          const demographics = [
            patient.name ? `Name: ${patient.name}` : null,
            patient.initials ? `Initials: ${patient.initials}` : null,
            patient.age ? `Age: ${patient.age}` : null,
            patient.sex ? `Sex: ${patient.sex}` : null,
          ].filter(Boolean).join(', ')
          if (demographics) patientBasicInfo = `### Demographics\n${demographics}`

          if (patient.chiefComplaint) {
            // Parse [tag] content format from chief_complaint
            const tags = (patient.chiefComplaint as string).match(/\[(\w+)\]\s*([^\[\]]+)/g) || []
            nodes = tags.map((t: string) => {
              const m = t.match(/\[(\w+)\]\s*(.+)/)
              return {
                node_type: (m?.[1] || 'finding').replace(/_/g, ' '),
                content_json: JSON.stringify({ text: (m?.[2] || t).trim() }),
                weight: 5, updated_at: Date.now(),
              }
            })
          }
        }
      }

      if ((!nodes || !nodes.length) && !patientBasicInfo) return ''

      const lines = (nodes || []).map(n => {
        try {
          const c = JSON.parse(n.content_json)
          const text = c.text || c.content || c.summary || ''
          const tag = n.node_type.replace(/_/g, ' ')
          const recency = Math.round(daysAgo(n.updated_at))
          return `[${tag}] ${text} (${recency}d ago, weight:${n.weight})`
        } catch { return '' }
      }).filter(Boolean)

      // 按类型分组
      const byType: Record<string, string[]> = {}
      for (const line of lines) {
        const type = line.split(']')[0].slice(1)
        if (!byType[type]) byType[type] = []
        byType[type].push(line)
      }

      const findingsText = Object.entries(byType)
        .map(([type, items]) => `### ${type}\n${items.join('\n')}`)
        .join('\n\n')

      return [patientBasicInfo, findingsText].filter(Boolean).join('\n\n')
    } catch {
      return ''
    }
  }

  // ── 事实格式化 (注意力越高 → 越详细) ──

  // #627: 统一渲染 — 与自动注入/patient block 共用 formatFactLine,
  // 去重后同一事实只以一种说法出现。截断仍是 layer3 特有行为(低注意力
  // → 缩短),由调用方先处理 content。
  private formatFact(fact: Fact, score: number): string {
    const content = score > 0.5 ? fact.content : fact.content.slice(0, 80) + '...'
    return formatFactLine({ ...fact, content })
  }
}
