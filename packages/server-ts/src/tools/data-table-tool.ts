/**
 * #406: load_data_table — parse uploaded/raw CSV into a normalized shape
 * with preview + summary. The LLM folds the summary into the conversation
 * context, then proposes the right analysis via run_stats_analysis.
 */
import { BaseTool, ToolResult } from './base-tool.js'
import { analyzeCsvText } from '../lib/data-table.js'
import fs from 'fs'
import path from 'path'

export class LoadDataTableTool extends BaseTool {
  constructor(private ctx: { userId: string }) { super() }

  get name(): string { return 'load_data_table' }
  get description(): string {
    return 'Parse tabular data (CSV text or an uploaded file_id) and return its shape, column types, preview and a summary. Shapes: values_2groups, values_paired, grouped_table, contingency_table, xy_pairs, survival_table, continuous_x_y. Use this BEFORE run_stats_analysis so the right test is chosen.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        csv_text: { type: 'string', description: 'CSV content (first row = headers)' },
        file_id: { type: 'string', description: 'An uploaded file id (text/CSV)' },
      },
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    let text = String(args.csv_text || '')
    if (!text && args.file_id) {
      const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', this.ctx.userId, 'uploads')
      const fp = path.join(dir, String(args.file_id))
      if (!fs.existsSync(fp)) return { success: false, error: `file not found: ${args.file_id}` }
      text = fs.readFileSync(fp, 'utf-8').slice(0, 200000)
    }
    if (!text.trim()) return { success: false, error: 'provide csv_text or file_id' }

    try {
      const info = analyzeCsvText(text)
      if (info.totalRows === 0) return { success: false, error: 'No data rows found (header-only CSV?)' }
      return {
        success: true,
        output: JSON.stringify({
          shape: info.shape,
          columns: info.columns,
          preview: info.preview,
          total_rows: info.totalRows,
          summary: info.summary,
        }, null, 2),
      }
    } catch (err) {
      return { success: false, error: `load_data_table failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}
