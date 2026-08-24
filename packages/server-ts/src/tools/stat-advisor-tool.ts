/**
 * stat_ai — statistical method advisor (#684). LLM-backed tool, isolated
 * from the deterministic stat-tools so the stats-engine "pure-TS fallback"
 * chain (stats-engine.ts → stat-tools → lib/stats-math) never touches a
 * non-deterministic dependency.
 */
import { BaseTool, ToolResult } from './base-tool.js'
import { parseLlmJson } from '../common/llm-json.js'

export class StatAdvisorTool extends BaseTool {
  get name(): string { return 'stat_ai' }
  get description(): string {
    return 'Recommend the right statistical test for a study design and interpret the result. Input: research question, outcome type, group structure, sample sizes. Output: { method, rationale, assumptions, alternative, interpretation } — use with stat_ttest/stat_chisq/stat_km to run the analysis.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Research question, e.g. "Compare PFS between treated and control arms"' },
        outcome_type: { type: 'string', enum: ['continuous', 'binary', 'time_to_event'], description: 'Outcome variable type' },
        groups: { type: 'integer', default: 2, description: 'Number of groups being compared' },
        design: { type: 'string', enum: ['independent', 'paired', 'correlation'], default: 'independent' },
        n: { type: 'integer', description: 'Total sample size (for power/appropriateness notes)' },
        result: { type: 'string', description: 'Optional observed result (e.g. p=0.012, HR 0.48) to interpret' },
      },
      required: ['question', 'outcome_type'],
    }
  }
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const question = String(args.question || '').trim()
    if (!question) return { success: false, error: 'question required' }
    try {
      const { deepseekChat, getApiKey, DEEPSEEK_CHAT_MODEL } = await import('../common/llm.js')
      const prompt = `You are a clinical biostatistician. For the study below, recommend the statistical test and interpret the result.

Question: ${question}
Outcome type: ${args.outcome_type}
Groups: ${args.groups || 2}
Design: ${args.design || 'independent'}
Sample size: ${args.n || 'unknown'}
${args.result ? `Observed result: ${args.result}` : ''}

Return ONLY a JSON object:
{
  "method": "recommended test name",
  "rationale": "1-2 sentences why",
  "assumptions": ["check 1", "check 2"],
  "alternative": "backup test if assumptions fail",
  "interpretation": "how to read the result (template with p/HR placeholders)"
}`

      const result = await deepseekChat([{ role: 'user', content: prompt }], getApiKey(), {
        model: DEEPSEEK_CHAT_MODEL,
        maxTokens: 800,
        telemetryContext: { userId: 'stat', workspaceId: 'stat', action: 'stat_advisor' },
      })
      const parsed = parseLlmJson<{
        method?: string; rationale?: string; assumptions?: unknown[]; alternative?: string; interpretation?: string
      }>(result)
      if (!parsed) return { success: false, error: 'Unparseable advisor output' }
      return {
        success: true,
        output: JSON.stringify({
          method: 'stat_advisor',
          recommendation: parsed.method || 'n/a',
          rationale: parsed.rationale || '',
          assumptions: parsed.assumptions || [],
          alternative: parsed.alternative || '',
          interpretation: parsed.interpretation || '',
        }, null, 2),
      }
    } catch (err) {
      return { success: false, error: `stat_ai failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}
