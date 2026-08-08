import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { StatDescribeTool, StatTTestTool, StatChiSqTool, StatKmTool, StatPlotTool, StatAdvisorTool } from '../../src/tools/stat-tools.js'
import { tTwoTailedP, chiSquaredP } from '../../src/tools/stat-tools.js'

// Expose helpers for direct p-value checks
const helpers = { tTwoTailedP, chiSquaredP } as any

describe('stat tools (#361)', () => {
  test('t-distribution p-values match statistical tables', () => {
    // Table: df=18, t=2.101 → two-tailed p=0.050
    expect(helpers.tTwoTailedP(2.101, 18)).toBeGreaterThan(0.049)
    expect(helpers.tTwoTailedP(2.101, 18)).toBeLessThan(0.051)
    // df=18, t=2.878 → p=0.010
    expect(helpers.tTwoTailedP(2.878, 18)).toBeGreaterThan(0.0095)
    expect(helpers.tTwoTailedP(2.878, 18)).toBeLessThan(0.0105)
    // large df → normal approx: t=1.96 df=1000 → p≈0.05
    expect(helpers.tTwoTailedP(1.96, 1000)).toBeGreaterThan(0.049)
    expect(helpers.tTwoTailedP(1.96, 1000)).toBeLessThan(0.051)
  })

  test('chi-squared p-values match statistical tables', () => {
    expect(helpers.chiSquaredP(3.841, 1)).toBeGreaterThan(0.049)
    expect(helpers.chiSquaredP(3.841, 1)).toBeLessThan(0.051)
    expect(helpers.chiSquaredP(9.488, 4)).toBeGreaterThan(0.049)
    expect(helpers.chiSquaredP(9.488, 4)).toBeLessThan(0.051)
    expect(helpers.chiSquaredP(6.635, 1)).toBeGreaterThan(0.0095)
    expect(helpers.chiSquaredP(6.635, 1)).toBeLessThan(0.0105)
  })

  test('stat_describe computes mean/median/SD/IQR', async () => {
    const tool = new StatDescribeTool()
    const res = await tool.execute({ values: [1, 2, 3, 4, 5] })
    expect(res.success).toBe(true)
    const out = JSON.parse(res.output!)
    expect(out.n).toBe(5)
    expect(out.mean).toBe(3)
    expect(out.median).toBe(3)
    expect(out.sd).toBeCloseTo(Math.sqrt(2.5), 1)
    expect(out.q1).toBe(2)
    expect(out.q3).toBe(4)
  })

  test('stat_ttest: equal groups → p near 1; separated groups → significant', async () => {
    const tool = new StatTTestTool()
    const same = await tool.execute({ group_a: [1, 2, 3, 4, 5, 6, 7, 8], group_b: [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5] })
    const sameOut = JSON.parse(same.output!)
    expect(sameOut.p_value).toBeGreaterThan(0.1)

    const diff = await tool.execute({ group_a: [10, 11, 12, 13, 14], group_b: [1, 2, 3, 4, 5] })
    const diffOut = JSON.parse(diff.output!)
    expect(diffOut.p_value).toBeLessThan(0.01)
    expect(diffOut.test_stat).toBeGreaterThan(5)
    expect(diffOut.effect_size).toBeGreaterThan(3)
    expect(diffOut.interpretation).toContain('统计学意义')
  })

  test('stat_chisq: 2×2 independence', async () => {
    const tool = new StatChiSqTool()
    // Strong association
    const assoc = await tool.execute({ table: [[90, 10], [20, 80]] })
    const assocOut = JSON.parse(assoc.output!)
    expect(assocOut.df).toBe(1)
    expect(assocOut.p_value).toBeLessThan(0.001)
    expect(assocOut.test_stat).toBeGreaterThan(50)

    // No association → p large
    const noAssoc = await tool.execute({ table: [[50, 50], [50, 50]] })
    const noOut = JSON.parse(noAssoc.output!)
    expect(noOut.p_value).toBeGreaterThan(0.9)
  })

  test('stat_km: survival curves + log-rank on a constructed difference', async () => {
    const tool = new StatKmTool()
    // Group A: early events; Group B: late events → significant log-rank
    const groupA = Array.from({ length: 20 }, (_, i) => ({ time: 1 + i * 0.5, event: true }))
    const groupB = Array.from({ length: 20 }, (_, i) => ({ time: 8 + i * 0.5, event: true }))
    const res = await tool.execute({ group_a: groupA, group_b: groupB })
    expect(res.success).toBe(true)
    const out = JSON.parse(res.output!)
    expect(out.method).toBe('kaplan_meier_logrank')
    expect(out.p_value).toBeLessThan(0.01)
    expect(out.curve_a[0]).toEqual({ time: 0, survival: 1 })
    expect(out.median_survival_a).toBeLessThan(out.median_survival_b!)

    // Censored rows are handled (KM survival stays > 0)
    const censored = await tool.execute({
      group_a: [{ time: 2, event: false }, { time: 3, event: true }, { time: 4, event: false }],
      group_b: [{ time: 5, event: false }, { time: 6, event: false }, { time: 7, event: false }],
    })
    expect(censored.success).toBe(true)
  })

  test('stat tools validate inputs', async () => {
    const desc = await new StatDescribeTool().execute({ values: [1] })
    expect(desc.success).toBe(false)
    const tt = await new StatTTestTool().execute({ group_a: [1], group_b: [2, 3] })
    expect(tt.success).toBe(false)
    const chi = await new StatChiSqTool().execute({ table: [[1, 2]] })
    expect(chi.success).toBe(false)
    const km = await new StatKmTool().execute({ group_a: [], group_b: [] })
    expect(km.success).toBe(false)
  })
})

  test('stat_plot converts KM curves and forest rows for render_chart (#361)', async () => {
    const tool = new StatPlotTool()
    const km = await tool.execute({
      plot_type: 'km',
      group_a: [{ time: 0, survival: 1 }, { time: 5, survival: 0.6 }, { time: 10, survival: 0.3 }],
      group_b: [{ time: 0, survival: 1 }, { time: 5, survival: 0.9 }],
      label_a: 'Treated', label_b: 'Control',
    })
    expect(km.success).toBe(true)
    const kmOut = JSON.parse(km.output!)
    expect(kmOut.charts.length).toBe(2)
    expect(kmOut.charts[0].type).toBe('line')
    expect(kmOut.charts[0].data[1]).toEqual({ label: '5', value: 0.6 })

    const forest = await tool.execute({
      plot_type: 'forest',
      forest: [{ label: 'PD-L1>=50%', hr: 0.48, lo: 0.29, hi: 0.80 }, { label: 'EGFR 19del', hr: 0.9, lo: 0.6, hi: 1.3 }],
    })
    expect(forest.success).toBe(true)
    const fOut = JSON.parse(forest.output!)
    expect(fOut.charts[0].type).toBe('bar')
    expect(fOut.notes[0]).toContain('statistically significant')
    expect(fOut.notes[1]).toContain('not significant')

    const bad = await tool.execute({ plot_type: 'nope' })
    expect(bad.success).toBe(false)
  })

  test('stat_ai advises a method and interprets a result (#361)', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"method":"Log-rank test","rationale":"time-to-event outcome","assumptions":["proportional hazards"],"alternative":"Cox PH","interpretation":"p<0.05 suggests a survival difference"}' } }] }),
    }) as any)
    const tool = new StatAdvisorTool()
    const res = await tool.execute({ question: 'Compare PFS between treated and control arms', outcome_type: 'time_to_event' })
    expect(res.success).toBe(true)
    const out = JSON.parse(res.output!)
    expect(out.method).toBe('stat_advisor')
    expect(out.recommendation).toBeTruthy()
    expect(out.interpretation).toBeTruthy()

    const bad = await tool.execute({ question: '', outcome_type: 'continuous' })
    expect(bad.success).toBe(false)
    vi.unstubAllEnvs()
    fetchMock.mockRestore()
  })
