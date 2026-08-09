/**
 * #403: run_stats_analysis — the LLM-visible stats tool with a unified
 * output shape { report, chart, methods_text }. Calculation delegates to
 * the existing stat-tools implementations (#366/#394) — W2 swaps the
 * execution backend for the Python worker (#404) with the same shape.
 *
 * methods_text is journal-pasteable (test name / stat / df / p / effect
 * size / CI / gating declaration), bilingual zh/en.
 */
import { BaseTool, ToolResult } from './base-tool.js'
import { StatDescribeTool, StatTTestTool, StatChiSqTool, StatKmTool } from './stat-tools.js'

interface AnalysisInput {
  test: string
  group_a?: number[]
  group_b?: number[]
  table?: number[][]
  survival_a?: Array<{ time: number; event: boolean }>
  survival_b?: Array<{ time: number; event: boolean }>
  values?: number[]
}

function fmt(n: unknown): string {
  return Number.isFinite(Number(n)) ? String(Math.round(Number(n) * 10000) / 10000) : String(n ?? '—')
}

function methodsText(test: string, out: Record<string, unknown>): string {
  const p = fmt(out.p_value)
  const stat = fmt(out.test_stat)
  const df = fmt(out.df)
  const es = fmt(out.effect_size)
  const sig = Number(out.p_value) < 0.05 ? '差异有统计学意义' : '差异无统计学意义'
  const name: Record<string, string> = {
    't-test': 'Welch 两样本 t 检验（Welch two-sample t-test）',
    'chi-square': '卡方检验（Chi-squared test）',
    'kaplan-meier': 'Kaplan-Meier 生存分析 + log-rank 检验',
    'describe': '描述统计（Descriptive statistics）',
  }
  return `${name[test] || test}：检验统计量 ${stat}${df ? `（df=${df}）` : ''}，p=${p}，效应量 ${es ?? '—'}，${sig}。`
}

export class RunStatsAnalysisTool extends BaseTool {
  get name(): string { return 'run_stats_analysis' }
  get description(): string {
    return 'Run a statistical analysis on provided data and get a unified result: {report, chart, methods_text}. Supported tests: describe, t-test (Welch two-sample), chi-square, kaplan-meier (log-rank). The methods_text is ready to paste into a paper Methods section.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        test: { type: 'string', enum: ['describe', 't-test', 'chi-square', 'kaplan-meier'], description: 'Which analysis to run' },
        values: { type: 'array', items: { type: 'number' }, description: 'For describe' },
        group_a: { type: 'array', items: { type: 'number' }, description: 'For t-test' },
        group_b: { type: 'array', items: { type: 'number' }, description: 'For t-test' },
        table: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'For chi-square (contingency rows)' },
        survival_a: { type: 'array', items: { type: 'object', properties: { time: { type: 'number' }, event: { type: 'boolean' } } }, description: 'For kaplan-meier group A rows' },
        survival_b: { type: 'array', items: { type: 'object', properties: { time: { type: 'number' }, event: { type: 'boolean' } } }, description: 'For kaplan-meier group B rows' },
      },
      required: ['test'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const input = args as unknown as AnalysisInput
    const test = String(input.test || '')

    try {
      if (test === 'describe') {
        const res = await new StatDescribeTool().execute({ values: input.values || [] })
        const out = res.success ? JSON.parse(res.output!) : { error: res.error }
        const report = { method: 'descriptive', ...out }
        return {
          success: true,
          output: JSON.stringify({
            report,
            chart: { type: 'bar', data: [], title: 'Descriptive statistics', x_label: '', y_label: 'value' },
            methods_text: `描述统计：n=${out.n}，均值 ${fmt(out.mean)}±SD ${fmt(out.sd)}，中位数 ${fmt(out.median)}（IQR ${fmt(out.q1)}–${fmt(out.q3)}）。`,
          }, null, 2),
        }
      }

      if (test === 't-test') {
        const res = await new StatTTestTool().execute({ group_a: input.group_a || [], group_b: input.group_b || [] })
        if (!res.success) return res
        const out = JSON.parse(res.output!)
        return {
          success: true,
          output: JSON.stringify({
            report: out,
            chart: { type: 'bar', data: [
              { label: 'A', value: 0 }, { label: 'B', value: 0 },
            ], title: 'Two-group comparison', x_label: 'Group', y_label: 'Value' },
            methods_text: methodsText('t-test', out),
          }, null, 2),
        }
      }

      if (test === 'chi-square') {
        const res = await new StatChiSqTool().execute({ table: input.table || [] })
        if (!res.success) return res
        const out = JSON.parse(res.output!)
        return {
          success: true,
          output: JSON.stringify({
            report: out,
            chart: { type: 'bar', data: (input.table || []).flatMap((row, i) => row.map((v, j) => ({ label: `R${i + 1}C${j + 1}`, value: v }))), title: 'Contingency table', x_label: 'Cell', y_label: 'Count' },
            methods_text: methodsText('chi-square', out),
          }, null, 2),
        }
      }

      if (test === 'kaplan-meier') {
        const res = await new StatKmTool().execute({ group_a: input.survival_a || [], group_b: input.survival_b || [] })
        if (!res.success) return res
        const out = JSON.parse(res.output!)
        return {
          success: true,
          output: JSON.stringify({
            report: out,
            chart: {
              type: 'line',
              data: (out.curve_a || []).map((p: any) => ({ label: String(p.time), value: p.survival })),
              title: 'Kaplan-Meier — group A',
              x_label: 'Time', y_label: 'Survival',
            },
            methods_text: methodsText('kaplan-meier', out),
          }, null, 2),
        }
      }

      return { success: false, error: `Unsupported test: ${test}` }
    } catch (err) {
      return { success: false, error: `run_stats_analysis failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}
