/**
 * #845 环③ — skill 提案审批的信任设计(memory 层:shared/skills 两侧共用,遵守 #679 分层):diff 预览。
 * 审批者必须看到"激活后医生会看到什么"(剧本卡样例)而非抽象 JSON,
 * 附 evidence 展示(观察次数/修正率/溯源会话)。
 */
import type { MemoryProposalRow } from './contracts.js'

export interface SkillProposalCard {
  kind: 'skill_card'
  /** 剧本卡(激活后 Layer 4 注入摘要的形状) */
  title: string
  description: string
  steps: string[]
  followRate: string
  /** 证据展示(审批 UI 反查) */
  evidence: {
    observationCount: number
    correctionRate: number
    trajectoryCount: number
    sessionIds: string[]
  }
  scope: string
  source: string
}

/** 剧本卡渲染 — 与设计 §3.4 的激活摘要形状一致。 */
export function renderSkillProposalCard(proposal: MemoryProposalRow): SkillProposalCard | null {
  if (proposal.kind !== 'skill' || !proposal.payload) return null
  try {
    const parsed = JSON.parse(proposal.payload)
    const s = parsed?.skill || parsed
    if (!s?.name) return null
    const steps = Array.isArray(s.steps) ? s.steps.map(String) : []
    const followRate = Number(s.followRate ?? 0)
    const ev = s.evidence || {}
    return {
      kind: 'skill_card',
      title: String(s.name),
      description: String(s.description || ''),
      steps,
      followRate: `${(followRate * 100).toFixed(0)}%${followRate === 0 ? '(新技能,从零起算)' : ''}`,
      evidence: {
        observationCount: Number(ev.observationCount) || 0,
        correctionRate: Number(ev.correctionRate) || 0,
        trajectoryCount: Array.isArray(ev.trajectoryIds) ? ev.trajectoryIds.length : 0,
        sessionIds: Array.isArray(ev.sessionIds) ? ev.sessionIds.map(String).slice(0, 10) : [],
      },
      scope: String(s.scope || 'personal'),
      source: String(s.source || 'synthesis'),
    }
  } catch {
    return null
  }
}

/** diff 预览:通过前(无此技能)× 通过后(剧本卡) — 存入 approvalRequest.diff。 */
export function renderSkillDiff(card: SkillProposalCard): { before: string; after: string } {
  const cardText = [
    `🧩 技能卡:${card.title}`,
    `适用:${card.description}`,
    card.steps.length > 0 ? `步骤:\n${card.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}` : '步骤:(空)',
    `遵循率:${card.followRate}`,
    `证据:${card.evidence.observationCount} 次观察 / 修正率 ${(card.evidence.correctionRate * 100).toFixed(0)}% / ${card.evidence.trajectoryCount} 条轨迹`,
    `激活后行为:任务型回合(${card.scope === 'institution' ? '机构' : '个人'}范围)按剧本执行,模型可 load_skill 拉取全文`,
  ].join('\n')
  return {
    before: '（当前无此技能 — 激活后本回合零 skill 注入）',
    after: cardText,
  }
}
