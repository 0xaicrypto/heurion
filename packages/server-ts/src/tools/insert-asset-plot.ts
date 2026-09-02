/**
 * insert_asset plot executor (#789②) — series normalization + contract
 * validation + render pipeline, extracted from insert-asset-tool.ts.
 */
import { validateRenderContent, SCHEMA_VERSION } from '@heurion/contracts'
import type { ToolResult } from './base-tool.js'
import type { ToolExecutionPlane } from './tool-registry.js'
import { runRenderJob } from './asset-render-pipeline.js'

/** plot 归一化 + 契约校验(纯) — 单测可直达。 */
export function buildPlotContent(args: Record<string, unknown>): { ok: true; content: Record<string, unknown>; plotType: string; title: string } | { ok: false; error: string } {
  const plotType = ['bar', 'line', 'pie'].includes(String(args.plot_type)) ? String(args.plot_type) : 'bar'
  const title = String(args.title || '').trim()
  if (!title) return { ok: false, error: 'plot 需要 title' }
  const rawSeries = Array.isArray(args.series) ? args.series : []
  if (rawSeries.length === 0) return { ok: false, error: 'plot 需要 series 数据' }
  let series: Array<{ label: string; x: number[]; y: number[] }>
  try {
    series = rawSeries.map((s: any, i: number) => {
      const y = Array.isArray(s?.y) ? s.y.map(Number) : []
      if (y.length === 0 || y.some((v: number) => !Number.isFinite(v))) {
        throw new Error(`series[${i}].y 必须是非空数字数组`)
      }
      let x = Array.isArray(s?.x) ? s.x.map(Number) : []
      if (x.length === 0) x = Array.from({ length: y.length }, (_, k) => k + 1)
      if (x.length !== y.length) {
        throw new Error(`series[${i}] 的 x(${x.length}) 与 y(${y.length}) 长度不一致`)
      }
      if (x.some((v: number) => !Number.isFinite(v))) {
        throw new Error(`series[${i}].x 含非法数字`)
      }
      return { label: String(s?.label || `系列 ${i + 1}`), x, y }
    })
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  const content = {
    schemaVersion: SCHEMA_VERSION,
    type: plotType as 'bar' | 'line' | 'pie',
    title,
    ...(typeof args.x_label === 'string' && args.x_label.trim() ? { x_label: args.x_label.trim() } : {}),
    ...(typeof args.y_label === 'string' && args.y_label.trim() ? { y_label: args.y_label.trim() } : {}),
    series,
  }
  const check = validateRenderContent('sidecar.render_plot', content)
  if (!check.ok) {
    return { ok: false, error: `plot 数据未通过契约校验：${check.errors.join('；')}` }
  }
  return { ok: true, content: content as unknown as Record<string, unknown>, plotType, title }
}

export async function executeInsertPlot(input: {
  userId: string
  docId: string
  args: Record<string, unknown>
  plane: ToolExecutionPlane
  isPluginInstalled?: (pluginId: string) => Promise<boolean>
  /** 写回单点(工具类的 writeBlock)。 */
  writeBlock: (docId: string, block: string, args: Record<string, unknown>, summaryBase: string) => Promise<ToolResult>
}): Promise<ToolResult> {
  const { userId, docId, args, plane, writeBlock } = input

  if (input.isPluginInstalled && !(await input.isPluginInstalled('heurion/plot'))) {
    return { success: false, error: '图表渲染需要先在「插件市场」安装 heurion/plot 插件；表格(table)不受影响。' }
  }

  const built = buildPlotContent(args)
  if (!built.ok) return { success: false, error: built.error }

  const outcome = await runRenderJob({
    plane,
    userId,
    jobType: 'sidecar.render_plot',
    payload: {
      template_id: 'default',
      output_name: built.title.slice(0, 40).replace(/\s+/g, '_'),
      schema_version: SCHEMA_VERSION,
      content_type: 'sidecar.render_plot',
      data: built.content,
    },
    ext: 'png',
    prefix: 'plot',
    docId,
    displayBase: '',
  })
  if (!outcome.ok) {
    if (outcome.kind === 'timeout') return { success: false, error: `图表渲染超时（任务 ${outcome.jobId}），可稍后通过任务 ID 查询。` }
    if (outcome.kind === 'failed') return { success: false, error: `图表渲染失败：${outcome.reason}` }
    if (outcome.kind === 'no_file') return { success: false, error: '图表任务完成但没有返回文件。' }
    return { success: false, error: '无法获取渲染结果文件（fetchFile 为空）。' }
  }
  const { localFileId, url } = outcome.file

  const caption = typeof args.caption === 'string' ? args.caption.trim() : ''
  const block = `![${caption || built.title}](${url})`
  const result = await writeBlock(docId, block, args, `已插入图表「${built.title}」（${built.plotType}）`)
  if (result.success && result.output) {
    const parsed = JSON.parse(result.output)
    parsed.file = { fileId: localFileId, url }
    result.output = JSON.stringify(parsed)
  }
  return result
}
