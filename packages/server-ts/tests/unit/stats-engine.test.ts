import { describe, test, expect, vi, afterEach } from 'vitest'
import { createStatsEngine, setStatsEngineForTest } from '../../src/tools/stats-engine.js'
import { RunStatsAnalysisTool } from '../../src/tools/stats-analysis-tool.js'

/**
 * #445: stats engine Strategy — Python worker (scipy) when STATS_WORKER_URL
 * is set, TS fallback otherwise; both produce the unified report shape.
 */
describe('stats engine strategy (#445)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    setStatsEngineForTest(null)
  })

  test('STATS_WORKER_URL routes to the Python worker /analyze', async () => {
    vi.stubEnv('STATS_WORKER_URL', 'http://stats:8005')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        report: { method: 'welch_t', test_stat: 2.1, df: 10, p_value: 0.03, effect_size: 0.8, ci_95: [0.1, 0.9], interpretation: '差异有统计学意义', gating: { normality_gate: 'passed' } },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const engine = createStatsEngine()
    const out = await engine.analyze({ test: 't-test', group_a: [1, 2, 3], group_b: [4, 5, 6] })

    expect(out.method).toBe('welch_t')
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://stats:8005/analyze')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.test).toBe('t-test')
    expect(body.group_a).toEqual([1, 2, 3])
  })

  test('falls back to the TS implementation when STATS_WORKER_URL is unset', async () => {
    vi.stubEnv('STATS_WORKER_URL', '')
    const engine = createStatsEngine()
    const out = await engine.analyze({ test: 'describe', values: [1, 2, 3, 4] })
    expect(out.method).toBe('descriptive')
    expect(out.n).toBe(4)
    expect(out.mean).toBe(2.5)
  })

  test('run_stats_analysis tool returns the unified output shape via the engine', async () => {
    vi.stubEnv('STATS_WORKER_URL', '')
    const tool = new RunStatsAnalysisTool()
    const res = await tool.execute({ test: 'chi-square', table: [[10, 20], [30, 40]] })
    expect(res.success).toBe(true)
    const parsed = JSON.parse(res.output!)
    expect(parsed.report.method).toBe('chisq')
    expect(parsed.report.p_value).toBeGreaterThan(0)
    expect(parsed.report.p_value).toBeLessThan(1)
    expect(parsed.methods_text).toContain('卡方检验')
  })

  test('python engine failure surfaces as a tool error', async () => {
    vi.stubEnv('STATS_WORKER_URL', 'http://stats:8005')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }))
    const engine = createStatsEngine()
    await expect(engine.analyze({ test: 't-test', group_a: [1], group_b: [2] })).rejects.toThrow(/stats worker HTTP 500/)
  })
})
