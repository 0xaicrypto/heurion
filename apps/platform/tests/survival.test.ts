import { describe, it, expect } from 'vitest'
import {
  normalizeEventStatus,
  calculateSingleGroupKm,
  calculateLogRankTest,
  calculateCoxRegression,
  buildNumberAtRiskTable,
  renderKmCurveSvg,
  renderForestPlotSvg,
  generateSurvivalNarrative,
  generateSurvivalMarkdownTable,
  generateSurvivalAnalysis,
} from '../src/datasets/survival.ts'

describe('临床科研生存分析套件 (Survival Analysis Suite)', () => {
  // 模拟真实肿瘤临床研究队列 (Treatment arm vs Control arm)
  const clinicalCohort = [
    // 试验组 (Treatment): 较长生存期
    { ptid: 'P01', arm: 'Treatment', os_months: 6, status: 0, age: 58, stage: 3 },
    { ptid: 'P02', arm: 'Treatment', os_months: 12, status: 0, age: 62, stage: 2 },
    { ptid: 'P03', arm: 'Treatment', os_months: 15, status: 1, age: 70, stage: 4 },
    { ptid: 'P04', arm: 'Treatment', os_months: 20, status: 0, age: 55, stage: 2 },
    { ptid: 'P05', arm: 'Treatment', os_months: 24, status: 1, age: 67, stage: 3 },
    { ptid: 'P06', arm: 'Treatment', os_months: 30, status: 0, age: 59, stage: 3 },
    { ptid: 'P07', arm: 'Treatment', os_months: 36, status: 1, age: 64, stage: 4 },
    { ptid: 'P08', arm: 'Treatment', os_months: 42, status: 0, age: 52, stage: 1 },
    { ptid: 'P09', arm: 'Treatment', os_months: 48, status: 0, age: 60, stage: 2 },
    { ptid: 'P10', arm: 'Treatment', os_months: 54, status: 1, age: 71, stage: 4 },
    // 对照组 (Control): 较短生存期，较早发生事件
    { ptid: 'P11', arm: 'Control', os_months: 4, status: 1, age: 65, stage: 3 },
    { ptid: 'P12', arm: 'Control', os_months: 8, status: 1, age: 68, stage: 4 },
    { ptid: 'P13', arm: 'Control', os_months: 11, status: 1, age: 59, stage: 2 },
    { ptid: 'P14', arm: 'Control', os_months: 14, status: 0, age: 61, stage: 3 },
    { ptid: 'P15', arm: 'Control', os_months: 18, status: 1, age: 72, stage: 4 },
    { ptid: 'P16', arm: 'Control', os_months: 22, status: 1, age: 66, stage: 3 },
    { ptid: 'P17', arm: 'Control', os_months: 28, status: 1, age: 63, stage: 4 },
    { ptid: 'P18', arm: 'Control', os_months: 35, status: 0, age: 57, stage: 2 },
    { ptid: 'P19', arm: 'Control', os_months: 40, status: 1, age: 69, stage: 4 },
    { ptid: 'P20', arm: 'Control', os_months: 45, status: 1, age: 74, stage: 3 },
  ]

  it('1. 事件状态归一化 (normalizeEventStatus)', () => {
    expect(normalizeEventStatus(1)).toBe(1)
    expect(normalizeEventStatus(0)).toBe(0)
    expect(normalizeEventStatus('1')).toBe(1)
    expect(normalizeEventStatus('0')).toBe(0)
    expect(normalizeEventStatus('dead')).toBe(1)
    expect(normalizeEventStatus('alive')).toBe(0)
    expect(normalizeEventStatus('relapse')).toBe(1)
    expect(normalizeEventStatus('censored')).toBe(0)
    expect(normalizeEventStatus('yes')).toBe(1)
    expect(normalizeEventStatus('no')).toBe(0)
    expect(normalizeEventStatus(null)).toBeNull()
    expect(normalizeEventStatus(undefined)).toBeNull()
    expect(normalizeEventStatus('')).toBeNull()
  })

  it('2. 单组 Kaplan-Meier 累积生存率与中位生存时间计算', () => {
    const controlRecords = clinicalCohort
      .filter(r => r.arm === 'Control')
      .map(r => ({ time: r.os_months, event: r.status }))

    const km = calculateSingleGroupKm(controlRecords, 'Control', '对照组', [12, 24, 36])

    expect(km.total_n).toBe(10)
    expect(km.events_n).toBe(8)
    expect(km.censored_n).toBe(2)
    expect(km.event_rate).toBe(80)

    // 生存率随时间严格单调不增
    for (let i = 1; i < km.timeline.length; i++) {
      expect(km.timeline[i]!.surv).toBeLessThanOrEqual(km.timeline[i - 1]!.surv)
      expect(km.timeline[i]!.surv).toBeGreaterThanOrEqual(0)
      expect(km.timeline[i]!.surv).toBeLessThanOrEqual(1)
    }

    // 中位生存期应能正常检出
    expect(km.median_time).not.toBeNull()
    expect(km.median_time).toBeGreaterThan(0)

    // 里程碑生存率
    expect(km.milestone_survival[12]).toBeDefined()
    expect(km.milestone_survival[12]?.surv_formatted).toContain('%')
  })

  it('3. 组间 Log-rank 统计检验与显著性判定', () => {
    const treat = clinicalCohort.filter(r => r.arm === 'Treatment').map(r => ({ time: r.os_months, event: r.status }))
    const ctrl = clinicalCohort.filter(r => r.arm === 'Control').map(r => ({ time: r.os_months, event: r.status }))

    const kmTreat = calculateSingleGroupKm(treat, 'Treatment', '试验组')
    const kmCtrl = calculateSingleGroupKm(ctrl, 'Control', '对照组')

    const lr = calculateLogRankTest([kmTreat, kmCtrl])

    expect(lr.df).toBe(1)
    expect(lr.chi2).toBeGreaterThan(0)
    expect(lr.p_value).toBeGreaterThan(0)
    expect(lr.p_value).toBeLessThanOrEqual(1.0)
    expect(lr.p_value_formatted).toBeTruthy()

    // 对照组发生事件数应高于预期值，试验组应低于预期值
    const treatStat = lr.group_stats.find(s => s.group === 'Treatment')!
    const ctrlStat = lr.group_stats.find(s => s.group === 'Control')!
    expect(treatStat.observed).toBeLessThan(treatStat.expected)
    expect(ctrlStat.observed).toBeGreaterThan(ctrlStat.expected)
  })

  it('4. Cox 比例风险回归与风险比 HR 计算', () => {
    const coxData = clinicalCohort.map(r => ({
      time: r.os_months,
      event: r.status,
      is_treatment: r.arm === 'Treatment' ? 1 : 0,
      age: r.age,
      stage: r.stage,
    }))

    const cox = calculateCoxRegression(coxData, ['is_treatment', 'age', 'stage'])

    expect(cox.sample_size).toBe(20)
    expect(cox.events_count).toBe(12)
    expect(cox.covariates.length).toBe(3)

    const treatCov = cox.covariates.find(c => c.variable === 'is_treatment')!
    expect(treatCov.hr).toBeLessThan(1.0) // 试验组为保护因素，HR < 1
    expect(treatCov.hr_ci_lower).toBeGreaterThan(0)
    expect(treatCov.hr_ci_upper).toBeGreaterThan(treatCov.hr_ci_lower)
    expect(treatCov.hr_formatted).toContain('(')

    // C-index 在 0.5 ~ 1.0 之间
    expect(cox.c_index).toBeGreaterThanOrEqual(0.5)
    expect(cox.c_index).toBeLessThanOrEqual(1.0)
  })

  it('5. 风险集随时间统计表 (buildNumberAtRiskTable)', () => {
    const treat = clinicalCohort.filter(r => r.arm === 'Treatment').map(r => ({ time: r.os_months, event: r.status }))
    const ctrl = clinicalCohort.filter(r => r.arm === 'Control').map(r => ({ time: r.os_months, event: r.status }))

    const kmTreat = calculateSingleGroupKm(treat, 'Treatment', '试验组')
    const kmCtrl = calculateSingleGroupKm(ctrl, 'Control', '对照组')

    const riskTable = buildNumberAtRiskTable([kmTreat, kmCtrl], 50, 5)

    expect(riskTable.time_points.length).toBeGreaterThanOrEqual(5)
    expect(riskTable.groups.length).toBe(2)
    // t=0 时应包含全部在保样本
    expect(riskTable.groups[0]!.counts[0]).toBe(10)
    expect(riskTable.groups[1]!.counts[0]).toBe(10)
    // 随时间推移人数递减
    const lastIdx = riskTable.time_points.length - 1
    expect(riskTable.groups[0]!.counts[lastIdx]!).toBeLessThanOrEqual(10)
  })

  it('6. 医学出版级 KM 曲线与 Cox 森林图矢量 SVG 渲染', () => {
    const treat = clinicalCohort.filter(r => r.arm === 'Treatment').map(r => ({ time: r.os_months, event: r.status }))
    const ctrl = clinicalCohort.filter(r => r.arm === 'Control').map(r => ({ time: r.os_months, event: r.status }))
    const kmTreat = calculateSingleGroupKm(treat, 'Treatment', '试验组')
    const kmCtrl = calculateSingleGroupKm(ctrl, 'Control', '对照组')
    const lr = calculateLogRankTest([kmTreat, kmCtrl])
    const riskTable = buildNumberAtRiskTable([kmTreat, kmCtrl], 54, 5)

    const svg = renderKmCurveSvg({
      title: 'Overall Survival in Advanced NSCLC',
      time_unit: 'Months',
      groups: [kmTreat, kmCtrl],
      log_rank: lr,
      risk_table: riskTable
    })

    expect(svg).toContain('<svg')
    expect(svg).toContain('</svg>')
    expect(svg).toContain('Overall Survival in Advanced NSCLC')
    expect(svg).toContain('Cumulative Survival Probability')
    expect(svg).toContain('Time (Months)')
    expect(svg).toContain('No. at Risk')
    expect(svg).toContain('Log-rank P =')

    // 森林图
    const coxData = clinicalCohort.map(r => ({
      time: r.os_months,
      event: r.status,
      is_treatment: r.arm === 'Treatment' ? 1 : 0,
      stage: r.stage,
    }))
    const cox = calculateCoxRegression(coxData, ['is_treatment', 'stage'])
    const forestSvg = renderForestPlotSvg(cox)

    expect(forestSvg).toContain('<svg')
    expect(forestSvg).toContain('Hazard Ratio (95% CI)')
    expect(forestSvg).toContain('Favors Treatment')
  })

  it('7. 端到端生存分析主函数集成 (generateSurvivalAnalysis)', () => {
    const res = generateSurvivalAnalysis(clinicalCohort, {
      time_col: 'os_months',
      event_col: 'status',
      group_col: 'arm',
      covariates: ['stage', 'age'],
      time_unit: 'Months',
      milestones: [12, 24, 36],
      labels: {
        Treatment: '靶向联合治疗组',
        Control: '标准对照组',
        stage: '肿瘤分期 (TNM)',
        age: '年龄',
      },
      title: 'Phase III Trial: Overall Survival'
    })

    expect(res.title).toBe('Phase III Trial: Overall Survival')
    expect(res.groups.length).toBe(2)
    expect(res.log_rank).toBeDefined()
    expect(res.log_rank?.p_value).toBeDefined()
    expect(res.cox).toBeDefined()
    expect(res.svg).toContain('<svg')
    expect(res.forest_svg).toContain('<svg')
    expect(res.narrative).toContain('versus')
    expect(res.narrative).toContain('Log-rank')
    expect(res.markdown_table).toContain('| **靶向联合治疗组** |')
  })
})
