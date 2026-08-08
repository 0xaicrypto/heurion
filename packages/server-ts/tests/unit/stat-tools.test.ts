import { describe, test, expect } from 'vitest'
import { StatDescribeTool, StatTTestTool, StatChiSqTool, StatKmTool } from '../../src/tools/stat-tools.js'
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
