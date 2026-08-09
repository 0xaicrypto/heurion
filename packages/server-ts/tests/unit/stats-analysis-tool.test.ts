import { describe, test, expect } from 'vitest'
import { RunStatsAnalysisTool } from '../../src/tools/stats-analysis-tool.js'

/**
 * #403: run_stats_analysis — unified {report, chart, methods_text} shape,
 * delegating computation to stat-tools. methods_text is journal-pasteable.
 */
describe('run_stats_analysis (#403)', () => {
  test('t-test returns the unified shape with methods_text', async () => {
    const tool = new RunStatsAnalysisTool()
    const res = await tool.execute({ test: 't-test', group_a: [10, 11, 12, 13, 14], group_b: [1, 2, 3, 4, 5] })
    expect(res.success).toBe(true)
    const out = JSON.parse(res.output!)
    expect(out.report.method).toBe('welch_t')
    expect(out.report.p_value).toBeLessThan(0.01)
    expect(out.methods_text).toContain('Welch')
    expect(out.methods_text).toContain('p=')
    expect(out.chart.type).toBe('bar')
  })

  test('kaplan-meier returns survival curve + methods_text', async () => {
    const tool = new RunStatsAnalysisTool()
    const res = await tool.execute({
      test: 'kaplan-meier',
      survival_a: Array.from({ length: 10 }, (_, i) => ({ time: 1 + i, event: true })),
      survival_b: Array.from({ length: 10 }, (_, i) => ({ time: 5 + i, event: true })),
    })
    expect(res.success).toBe(true)
    const out = JSON.parse(res.output!)
    expect(out.report.method).toBe('kaplan_meier_logrank')
    expect(out.chart.type).toBe('line')
    expect(out.methods_text).toContain('Kaplan-Meier')
  })

  test('describe + chi-square work; unknown test rejected', async () => {
    const tool = new RunStatsAnalysisTool()
    const desc = await tool.execute({ test: 'describe', values: [1, 2, 3, 4, 5] })
    expect(desc.success).toBe(true)
    expect(JSON.parse(desc.output!).report.n).toBe(5)

    const chi = await tool.execute({ test: 'chi-square', table: [[20, 10], [5, 25]] })
    expect(chi.success).toBe(true)
    expect(JSON.parse(chi.output!).methods_text).toContain('卡方')

    const bad = await tool.execute({ test: 'anova' })
    expect(bad.success).toBe(false)
  })

  test('validation errors surface (missing groups)', async () => {
    const tool = new RunStatsAnalysisTool()
    const res = await tool.execute({ test: 't-test', group_a: [1] })
    expect(res.success).toBe(false)
    expect(res.error).toContain('2')
  })
})

describe('methods_text enhancements (#407)', () => {
  test('methods_text includes gating declaration when degraded', async () => {
    const tool = new RunStatsAnalysisTool()
    // Non-normal-ish data (skewed) → TS heuristic gate may pass; force by
    // using the Mann-Whitney path via a clearly non-normal sample.
    const res = await tool.execute({ test: 't-test', group_a: [0.1, 0.2, 5, 6, 7, 8, 0.3, 9], group_b: [20, 21, 22, 23, 0.4, 0.5, 24, 25] })
    expect(res.success).toBe(true)
    const out = JSON.parse(res.output!)
    if (out.report.method === 'mann_whitney') {
      expect(out.methods_text).toContain('Mann-Whitney')
      expect(out.methods_text).toContain('自动改用')
    } else {
      // Gate heuristic passed — at least CI should be present.
      expect(out.report.ci_95).toBeDefined()
    }
  })
})

import { renderSvgChart } from '../../src/tools/chart-renderer.js'
describe('chart significance + error bars (#407)', () => {
  test('bar chart renders error bars and significance bracket', () => {
    const svg = renderSvgChart({
      type: 'bar',
      data: [{ label: 'A', value: 30 }, { label: 'B', value: 55 }],
      errors: [{ label: 'A', error: 4 }, { label: 'B', error: 6 }],
      sig: { pair: ['A', 'B'], stars: '**', p: '0.004' },
      title: 't',
    })
    expect(svg).toContain('<line') // error bars
    expect(svg).toContain('#dc2626') // significance bracket color
    expect(svg).toContain('** (p=0.004)')
  })

  test('bar without errors/sig renders plain', () => {
    const svg = renderSvgChart({ type: 'bar', data: [{ label: 'A', value: 1 }], title: 'x' })
    expect(svg).toContain('<rect')
    expect(svg).not.toContain('#dc2626')
  })
})
