import fs from 'fs'
import path from 'path'
import { BaseTool, ToolResult } from './base-tool.js'
import prisma from '../common/prisma.js'
import { findNormalizedSpan, findFuzzySpan } from './edit-document-tool.js'
import { issueChartToken } from '../common/chart-token.js'
import { validateRenderContent, SCHEMA_VERSION } from '@heurion/contracts'
import type { ToolExecutionPlane } from './tool-registry.js'

/**
 * #765/#766 — insert_asset: the writing-canvas structured-asset tool.
 *
 * 动机（epic #764）：写作 chat 里"做一张 Table 1 / 画个 KM 曲线"类请求此前
 * 只能走前置路由渲染下载文件（旁路），内容与草稿脱节且从不写回正文。
 * 本工具把资产生成收进工具循环：模型自主决定时机、类型与数据，
 * 结果直接写入 Doc.body，快照 + doc_updated 推画布（与 edit_document 同管道）。
 *
 * - table（#765）：headers/rows → markdown 表格，无外部依赖。
 * - plot（#766）：模型直供 series 数据（不重付 LLM）→ 契约校验 →
 *   execution plane 渲 PNG → fetchFile 落盘 uploads + issueChartToken →
 *   `![图](url)` 插入（worker 下载 URL 有 token 且会过期，不能进文档）。
 * - export（#767）：内容源 = 草稿正文本身（markdown → sections/slides，
 *   跳过 LLM 重编）→ 渲 docx/pptx/pdf → 落盘 + 草稿内下载卡片行。
 *
 * 定位复用 edit_document 的三级匹配（空白塌缩 → 忽略空白 → 模糊）：
 * - anchor 命中 → 资产插入锚点片段之后；
 * - anchor 未命中 → 追加文末（summary 注明，供模型转告用户）；
 * - anchor 多次命中 → 报错引导提供更多上下文（与 range edit 一致）。
 * - 未提供 anchor → 追加文末。
 */

/** headers/rows → markdown 表格；单元格转义竖线与换行，短行补空。 */
export function buildMarkdownTable(headers: string[], rows: string[][]): string {
  const esc = (c: unknown) => String(c ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
  const n = headers.length
  const line = (cells: string[]) => `| ${cells.map(esc).join(' | ')} |`
  const out = [line(headers), `| ${headers.map(() => '---').join(' | ')} |`]
  for (const row of rows) {
    const cells = Array.from({ length: n }, (_, i) => row[i] ?? '')
    out.push(line(cells))
  }
  return out.join('\n')
}

export interface InsertAssetContext {
  userId: string
  sessionId?: string
  /** #766: plot/export 渲染需要 execution plane + 对应插件。 */
  executionPlane?: ToolExecutionPlane
  isPluginInstalled?: (pluginId: string) => Promise<boolean>
}

/** #767 — 导出格式 → 插件 id / 契约 content_type / job type / 模板 / mime。 */
const EXPORT_FORMATS: Record<string, { pluginId: string; contentType: 'sidecar.generate_docx' | 'sidecar.generate_pptx' | 'sidecar.convert_to_pdf'; templateId: string; ext: string; mime: string; label: string }> = {
  docx: { pluginId: 'heurion/docx', contentType: 'sidecar.generate_docx', templateId: 'case_summary', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word' },
  pptx: { pluginId: 'heurion/pptx', contentType: 'sidecar.generate_pptx', templateId: 'default', ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PPT' },
  pdf: { pluginId: 'heurion/pdf', contentType: 'sidecar.convert_to_pdf', templateId: 'default', ext: 'pdf', mime: 'application/pdf', label: 'PDF' },
}

/**
 * #767 — markdown 草稿 → 契约 document 内容模型（docx/pdf 共用）。
 * `#`/`##`/`###` 起始新 section（heading）；连续正文行逐行成 paragraph
 * （`-`/`*` 前缀 → bullet）。契约上限：30 sections / 100 段落 / 20000 字，
 * 超限折叠进末尾并注明（导出从不因超长静默丢内容之外的失败）。
 */
export function buildDocumentContent(body: string, title: string): { schemaVersion: number; title: string; sections: Array<{ heading: string; paragraphs: Array<{ type: 'paragraph'; text: string; style?: 'normal' | 'bullet' }> }> } {
  const sections: Array<{ heading: string; paragraphs: Array<{ type: 'paragraph'; text: string; style?: 'normal' | 'bullet' }> }> = []
  let current: { heading: string; paragraphs: Array<{ type: 'paragraph'; text: string; style?: 'normal' | 'bullet' }> } | null = null
  let docTitle = title
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      if (h[1].length === 1 && !current && sections.length === 0) {
        docTitle = h[2].slice(0, 500)
        continue
      }
      current = { heading: h[2].slice(0, 500), paragraphs: [] }
      sections.push(current)
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    const block = bullet
      ? { type: 'paragraph' as const, text: bullet[1].slice(0, 20000), style: 'bullet' as const }
      : { type: 'paragraph' as const, text: line.replace(/^#+\s*/, '').slice(0, 20000) }
    if (!current) {
      current = { heading: '概述', paragraphs: [] }
      sections.push(current)
    }
    if (current.paragraphs.length < 100) current.paragraphs.push(block)
    else if (current.paragraphs.length === 100) current.paragraphs.push({ type: 'paragraph', text: '（内容过长，其余段落已省略）' })
  }
  if (sections.length > 30) sections.length = 30
  return { schemaVersion: SCHEMA_VERSION, title: docTitle.slice(0, 500), sections }
}

/** #767 — markdown 草稿 → 契约 presentation 内容模型（`##` → slide）。 */
export function buildPresentationContent(body: string, title: string): { schemaVersion: number; title: string; slides: Array<{ title: string; content: Array<{ type: 'paragraph'; text: string; style?: 'normal' | 'bullet' }> }> } {
  const doc = buildDocumentContent(body, title)
  const slides = doc.sections.slice(0, 30).map((s) => ({
    title: s.heading,
    content: s.paragraphs.slice(0, 50),
  }))
  return { schemaVersion: SCHEMA_VERSION, title: doc.title, slides }
}

export class InsertAssetTool extends BaseTool {
  constructor(private ctx: InsertAssetContext) {
    super()
  }

  get name(): string { return 'insert_asset' }

  get description(): string {
    return [
      'Insert a structured asset into the current writing-session document.',
      "asset_type='table': pass headers + rows — a markdown table is generated and written into the document.",
      "asset_type='plot': pass plot_type (bar/line/pie), title and series [{label, x, y}] — the chart is rendered to PNG (requires the heurion/plot plugin) and embedded as an image.",
      "asset_type='export': pass format (docx/pptx/pdf) — the CURRENT DRAFT is converted and rendered as a downloadable file (requires the matching plugin); a download link card is appended to the document.",
      'Optionally pass anchor (a text fragment copied VERBATIM from the current document; whitespace/line-break differences are tolerated) to place the asset right AFTER that fragment. Without a match (or without anchor) it is appended at the end.',
      "Use this when the user asks for a table or chart IN the draft (Table 1, 基线特征表, 画图, 曲线, 图表…), or asks to export the draft (导出 Word, 生成 PPT, 转 PDF…) — do NOT paste raw markdown tables/image links yourself and do NOT use edit_document for this.",
    ].join(' ')
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        asset_type: { type: 'string', enum: ['table', 'plot', 'export'], description: 'Asset type: table, plot, or export (draft → downloadable file).' },
        // table
        headers: { type: 'array', items: { type: 'string' }, description: 'table: column headers.' },
        rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'table: rows, each an array of cell strings aligned with headers.' },
        // plot
        plot_type: { type: 'string', enum: ['bar', 'line', 'pie'], description: 'plot: chart type. KM/生存曲线用 line（x=时间，y=生存率）。' },
        title: { type: 'string', description: 'plot: chart title (required).' },
        x_label: { type: 'string', description: 'plot: x-axis label.' },
        y_label: { type: 'string', description: 'plot: y-axis label.' },
        series: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              x: { type: 'array', items: { type: 'number' }, description: 'x values; omit to use 1..n' },
              y: { type: 'array', items: { type: 'number' } },
            },
            required: ['y'],
          },
          description: 'plot: data series (x/y numeric arrays).',
        },
        // shared
        format: { type: 'string', enum: ['docx', 'pptx', 'pdf'], description: 'export: output format.' },
        caption: { type: 'string', description: 'table: bold caption line above; plot: image alt text (e.g. "Figure 1. PFS by PD-L1").' },
        anchor: { type: 'string', description: 'Optional: verbatim fragment from the current document; the asset is inserted right after it. Omit to append at the end.' },
        summary: { type: 'string', description: 'A one-line summary of what was inserted.' },
      },
      required: ['asset_type'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = this.ctx.sessionId || ''
    if (!sessionId.startsWith('doc-')) {
      return { success: false, error: 'insert_asset is only available in a document writing session' }
    }
    const docId = sessionId.slice(4)
    const assetType = String(args.asset_type || 'table')

    try {
      if (assetType === 'table') return await this.insertTable(docId, args)
      if (assetType === 'plot') return await this.insertPlot(docId, args)
      if (assetType === 'export') return await this.insertExport(docId, args)
      return { success: false, error: `Unsupported asset_type: ${assetType}（当前支持 table / plot / export）` }
    } catch (err) {
      return { success: false, error: `insert_asset failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }

  // ── table（#765）────────────────────────────────────────────────

  private async insertTable(docId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const headers = Array.isArray(args.headers) ? args.headers.map((h) => String(h)) : []
    const rows = Array.isArray(args.rows) ? args.rows.map((r) => (Array.isArray(r) ? r.map((c) => String(c)) : [String(r)])) : []
    if (headers.length === 0) return { success: false, error: 'headers 不能为空' }
    if (rows.length === 0) return { success: false, error: 'rows 不能为空' }
    const caption = typeof args.caption === 'string' ? args.caption.trim() : ''
    const table = buildMarkdownTable(headers, rows)
    const block = caption ? `**${caption}**\n\n${table}` : table
    return this.writeBlock(docId, block, args, `已插入表格（${rows.length} 行 × ${headers.length} 列）`)
  }

  // ── plot（#766）────────────────────────────────────────────────

  private async insertPlot(docId: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (this.ctx.isPluginInstalled && !(await this.ctx.isPluginInstalled('heurion/plot'))) {
      return { success: false, error: '图表渲染需要先在「插件市场」安装 heurion/plot 插件；表格(table)不受影响。' }
    }
    const plane = this.ctx.executionPlane
    if (!plane) {
      return { success: false, error: '执行平面（execution plane）未配置，无法渲染图表。请联系管理员检查 EXECUTION_PLANE_URL / WORKER_API_TOKEN。' }
    }

    // 数据归一化 — 模型直供，不重付 LLM。x 缺省 1..n；长度不一致报错让模型修。
    const plotType = ['bar', 'line', 'pie'].includes(String(args.plot_type)) ? String(args.plot_type) : 'bar'
    const title = String(args.title || '').trim()
    if (!title) return { success: false, error: 'plot 需要 title' }
    const rawSeries = Array.isArray(args.series) ? args.series : []
    if (rawSeries.length === 0) return { success: false, error: 'plot 需要 series 数据' }
    const series = rawSeries.map((s: any, i: number) => {
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
      return { success: false, error: `plot 数据未通过契约校验：${check.errors.join('；')}` }
    }

    const payload = {
      template_id: 'default',
      output_name: title.slice(0, 40).replace(/\s+/g, '_'),
      schema_version: SCHEMA_VERSION,
      content_type: 'sidecar.render_plot',
      data: content,
    }
    const job = await plane.enqueue({
      type: 'sidecar.render_plot',
      payload,
      tenant: { userId: this.ctx.userId },
    })

    const final = await this.pollJob(plane, job.job_id)
    if (!final) return { success: false, error: `图表渲染超时（任务 ${job.job_id}），可稍后通过任务 ID 查询。` }
    if (final.status !== 'completed') {
      const reason = String(final.error || (final.result as any)?.error || final.status)
      return { success: false, error: `图表渲染失败：${reason.slice(0, 200)}` }
    }
    const fileId = (final.result as any)?.file_id as string | undefined
    if (!fileId) return { success: false, error: '图表任务完成但没有返回文件。' }

    const bytes = await plane.fetchFile?.(fileId)
    if (!bytes || bytes.length === 0) {
      return { success: false, error: '无法获取渲染结果文件（fetchFile 为空）。' }
    }
    const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', this.ctx.userId, 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    const localFileId = `plot_${docId}_${Date.now()}.png`
    fs.writeFileSync(path.join(dir, localFileId), bytes)
    const token = issueChartToken(localFileId, this.ctx.userId)
    const url = `/api/v1/files/download/${localFileId}?token=${token}`

    const caption = typeof args.caption === 'string' ? args.caption.trim() : ''
    const block = `![${caption || title}](${url})`
    const result = await this.writeBlock(docId, block, args, `已插入图表「${title}」（${plotType}）`)
    if (result.success && result.output) {
      const parsed = JSON.parse(result.output)
      parsed.file = { fileId: localFileId, url }
      result.output = JSON.stringify(parsed)
    }
    return result
  }

  // ── export（#767）────────────────────────────────────────────────

  private async insertExport(docId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const format = String(args.format || '')
    const spec = EXPORT_FORMATS[format]
    if (!spec) return { success: false, error: 'export 需要 format: docx | pptx | pdf' }
    if (this.ctx.isPluginInstalled && !(await this.ctx.isPluginInstalled(spec.pluginId))) {
      return { success: false, error: `导出 ${spec.label} 需要先在「插件市场」安装 ${spec.pluginId} 插件。` }
    }
    const plane = this.ctx.executionPlane
    if (!plane) {
      return { success: false, error: '执行平面（execution plane）未配置，无法导出。请联系管理员检查 EXECUTION_PLANE_URL / WORKER_API_TOKEN。' }
    }

    const existing = await (prisma as any).doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
    if (!existing) return { success: false, error: `Document not found: ${docId}` }
    const body = String(existing.body || '')
    if (!body.trim()) return { success: false, error: '文档正文为空，无法导出。请先撰写内容。' }

    // 内容源 = 草稿正文本身（markdown → 契约模型），不重付 LLM 重编 —
    // 导出内容与草稿天然一致（epic #764 的"内容正确"目标）。
    const content = spec.contentType === 'sidecar.generate_pptx'
      ? buildPresentationContent(body, String(existing.title || 'Presentation'))
      : buildDocumentContent(body, String(existing.title || 'Document'))
    const check = validateRenderContent(spec.contentType, content)
    if (!check.ok) return { success: false, error: `导出内容未通过契约校验：${check.errors.join('；')}` }

    const payload = {
      template_id: spec.templateId,
      output_name: content.title.slice(0, 40).replace(/\s+/g, '_'),
      schema_version: SCHEMA_VERSION,
      content_type: spec.contentType,
      data: content,
    }
    const job = await plane.enqueue({ type: spec.contentType, payload, tenant: { userId: this.ctx.userId } })
    const final = await this.pollJob(plane, job.job_id)
    if (!final) return { success: false, error: `导出超时（任务 ${job.job_id}），可稍后通过任务 ID 查询。` }
    if (final.status !== 'completed') {
      const reason = String(final.error || (final.result as any)?.error || final.status)
      return { success: false, error: `导出失败：${reason.slice(0, 200)}` }
    }
    const fileId = (final.result as any)?.file_id as string | undefined
    if (!fileId) return { success: false, error: '导出任务完成但没有返回文件。' }

    const bytes = await plane.fetchFile?.(fileId)
    if (!bytes || bytes.length === 0) {
      return { success: false, error: '无法获取导出文件（fetchFile 为空）。' }
    }
    const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', this.ctx.userId, 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    const fileName = `${content.title.slice(0, 40).replace(/[\\/:*?"<>|\s]+/g, '_') || 'export'}.${spec.ext}`
    const localFileId = `export_${docId}_${Date.now()}.${spec.ext}`
    fs.writeFileSync(path.join(dir, localFileId), bytes)
    const token = issueChartToken(localFileId, this.ctx.userId)
    const url = `/api/v1/files/download/${localFileId}?token=${token}`

    // 下载卡片行写回草稿（快照 + doc_updated）— 渲染失败不会产生半截卡片。
    const card = `[下载 ${spec.label} 版（${fileName}）](${url})`
    const result = await this.writeBlock(docId, card, args, `已导出 ${spec.label}（${fileName}）`)
    if (result.success && result.output) {
      const parsed = JSON.parse(result.output)
      parsed.file = { fileId: localFileId, fileName, mimeType: spec.mime, url }
      result.output = JSON.stringify(parsed)
    }
    return result
  }

  private async pollJob(plane: ToolExecutionPlane, jobId: string, maxWaitMs = 30000, intervalMs = 1000): Promise<{ status: string; error?: unknown; result?: Record<string, unknown> } | null> {    const deadline = Date.now() + maxWaitMs
    while (Date.now() < deadline) {
      const status = await plane.getStatus(jobId)
      if (status && status.status !== 'pending' && status.status !== 'running') return status
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    return null
  }

  // ── 共用写回（#765 管道：快照 + doc_updated）──────────────────

  private async writeBlock(docId: string, block: string, args: Record<string, unknown>, summaryBase: string): Promise<ToolResult> {
    const anchor = typeof args.anchor === 'string' ? args.anchor.trim() : ''
    const existing = await (prisma as any).doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
    if (!existing) return { success: false, error: `Document not found: ${docId}` }
    const body = String(existing.body || '')

    let newBody: string
    let placement: string
    if (anchor) {
      const span = findNormalizedSpan(body, anchor) ?? findFuzzySpan(body, anchor)
      if (span) {
        // 多次命中判定与 range edit 一致 — 锚点不唯一必然插错位置。
        if (!span.fuzzy && span.normBody.indexOf(span.normNeedle, span.k + span.normNeedle.length) !== -1) {
          return {
            success: false,
            error: 'anchor 在文档中出现多次，请包含更多上下文让锚点唯一（比如加上前后句），或去掉 anchor 直接追加文末。',
          }
        }
        newBody = body.slice(0, span.end) + '\n\n' + block + body.slice(span.end)
        placement = `插入锚点「${anchor.slice(0, 30)}…」之后`
      } else {
        newBody = `${body.trimEnd()}\n\n${block}\n`
        placement = '锚点未命中，已追加文末（可提示用户位置）'
      }
    } else {
      newBody = body.trim() ? `${body.trimEnd()}\n\n${block}\n` : `${block}\n`
      placement = '追加文末'
    }

    const now = new Date().toISOString()
    if (newBody !== body) {
      await (prisma as any).docSnapshot.create({
        data: { docId, userId: this.ctx.userId, body, label: 'AI insert', createdAt: now },
      })
      await (prisma as any).doc.update({
        where: { id: docId },
        data: { body: newBody, updatedAt: now },
      })
    }

    const summary = String(args.summary || `${summaryBase}，${placement}`)
    return { success: true, output: JSON.stringify({ body: newBody, summary }) }
  }
}
