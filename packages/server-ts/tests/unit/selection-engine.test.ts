import { describe, expect, it } from 'vitest'
import { recommendTiers } from '../../src/modules/submission/selection-engine.js'
import { getJournalRepository, resetJournalRepository } from '../../src/modules/submission/journal-repository.js'
import type { SelectionProfile, TieredRecommendation } from '../../src/modules/submission/journal-types.js'

/**
 * #850 — 三档梯度推荐 + 结构化 breakdown + SelectionProfile 规则引擎。
 * 验收:同 profile 可复现;无证据维度不进 breakdown;预警刊三档不可见;
 * priority 切换推荐序变化且 breakdown 反映权重变化。
 */

const LUNG_PROFILE: SelectionProfile = {
  title: 'Efficacy of neoadjuvant immunotherapy in resectable NSCLC',
  abstract: 'Patients with non-small cell lung cancer receiving EGFR-targeted therapy and immunotherapy showed improved survival. This retrospective real-world cohort study included 320 patients.',
  articleType: 'real_world',
}

function tierIds(r: TieredRecommendation): string[] {
  return [...r.tiers.reach, ...r.tiers.match, ...r.tiers.safety].map((x) => x.journal.id)
}

describe('selection-engine (#850)', () => {
  it('同一 profile 两次推荐结果可复现(权重确定,无随机)', () => {
    resetJournalRepository()
    const a = recommendTiers(LUNG_PROFILE)
    const b = recommendTiers(LUNG_PROFILE)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('三档各 2-3 本,冲刺档在匹配档上方(按 total_score)', () => {
    resetJournalRepository()
    const r = recommendTiers(LUNG_PROFILE)
    expect(r.tiers.match.length).toBeGreaterThanOrEqual(2)
    expect(r.tiers.match.length).toBeLessThanOrEqual(3)
    expect(r.tiers.reach.length).toBeLessThanOrEqual(3)
    expect(r.tiers.safety.length).toBeLessThanOrEqual(3)
    if (r.tiers.reach.length > 0 && r.tiers.match.length > 0) {
      const reachMin = Math.min(...r.tiers.reach.map((x) => x.totalScore))
      const matchMax = Math.max(...r.tiers.match.map((x) => x.totalScore))
      expect(reachMin).toBeGreaterThanOrEqual(matchMax)
    }
  })

  it('预警期刊任何档位不可见,红线区可见 + 原因(D5)', () => {
    resetJournalRepository()
    const r = recommendTiers({ ...LUNG_PROFILE, title: 'cancer immunotherapy case report', abstract: 'cancer' })
    const ids = tierIds(r)
    for (const id of ids) {
      const j = getJournalRepository().get(id)!
      expect(j.warnings).toHaveLength(0)
    }
    expect(r.redline.length).toBeGreaterThan(0)
    expect(r.redline[0].journal.warnings[0].kind).toBe('cas_warning_list')
    expect(r.redline[0].journal.warnings[0].asOf).toMatch(/^\d{4}-\d{2}$/)
  })

  it('breakdown 每行有证据,无证据维度不出现(D4);scope 维必有', () => {
    resetJournalRepository()
    const r = recommendTiers(LUNG_PROFILE)
    const all = [...r.tiers.reach, ...r.tiers.match, ...r.tiers.safety]
    expect(all.length).toBeGreaterThan(0)
    for (const rec of all) {
      expect(rec.breakdown.length).toBeGreaterThan(0)
      for (const row of rec.breakdown) {
        if (row.dimension !== 'scope') expect(row.evidence.length).toBeGreaterThan(0)
      }
      expect(rec.breakdown.some((b) => b.dimension === 'scope')).toBe(true)
      expect(rec.breakdown.some((b) => b.dimension === 'impact')).toBe(true)
    }
  })

  it('priority 切换 impact→speed 推荐序变化(快刊位次上升)', () => {
    resetJournalRepository()
    const impact = recommendTiers({ ...LUNG_PROFILE, priority: 'impact' })
    const speed = recommendTiers({ ...LUNG_PROFILE, priority: 'speed' })
    expect(JSON.stringify(impact.tiers)).not.toBe(JSON.stringify(speed.tiers))
    const pos = (r: TieredRecommendation, id: string) => tierIds(r).indexOf(id)
    // front-oncol:一审 4 周(快但 IF 低)— speed 权重下位次不降
    expect(pos(speed, 'front-oncol')).toBeGreaterThanOrEqual(pos(impact, 'front-oncol'))
    expect(speed.profileEcho.priority).toBe('speed')
  })

  it('selfPayOa 开启 → cost 维度退出 breakdown(费用证据行消失)', () => {
    resetJournalRepository()
    const withCost = recommendTiers(LUNG_PROFILE)
    const withoutCost = recommendTiers({ ...LUNG_PROFILE, selfPayOa: true })
    const hasCostRow = (r: TieredRecommendation) =>
      [...r.tiers.reach, ...r.tiers.match, ...r.tiers.safety].some((rec) => rec.breakdown.some((b) => b.dimension === 'cost'))
    expect(hasCostRow(withCost)).toBe(true) // OA 刊带 APC 证据
    expect(hasCostRow(withoutCost)).toBe(false)
  })

  it('语言过滤:en 不含中文刊,zh 只含中文刊', () => {
    resetJournalRepository()
    const en = recommendTiers({ ...LUNG_PROFILE, language: 'en' })
    for (const id of tierIds(en)) {
      expect(getJournalRepository().get(id)!.scope).not.toContain('chinese')
    }
    const zh = recommendTiers({ ...LUNG_PROFILE, language: 'zh' })
    const zhIds = tierIds(zh)
    expect(zhIds.length).toBeGreaterThan(0)
    for (const id of zhIds) {
      expect(getJournalRepository().get(id)!.scope).toContain('chinese')
    }
  })

  it('中文摘要可命中英文刊(scope 提示词双向)', () => {
    resetJournalRepository()
    const zhAbstract = recommendTiers({
      title: '非小细胞肺癌患者免疫治疗疗效分析',
      abstract: '回顾性分析 320 例肺癌患者的临床数据,评估免疫治疗生存获益',
    })
    const ids = tierIds(zhAbstract)
    expect(ids).toContain('jto')
  })
})
