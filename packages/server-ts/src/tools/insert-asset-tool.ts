import { BaseTool, ToolResult } from './base-tool.js'
import prisma from '../common/prisma.js'
// #697: 匹配算法族下沉 lib。
import { findNormalizedSpan, findFuzzySpan } from '../lib/document-span-match.js'
// #789②: 纯构建器下沉 lib;图片内嵌/plot/export 执行器各立模块 —
// 工具类只剩参数分发与写回单点(writeBlock)。
import { buildMarkdownTable } from '../lib/asset-content.js'
import { safeParseDeckJson } from '../lib/asset-content.js'
import { writeDocVersion } from './doc-version-writer.js'
import { executeInsertPlot } from './insert-asset-plot.js'
import { executeInsertExport } from './insert-asset-export.js'
import type { ToolExecutionPlane } from './tool-registry.js'

export { buildMarkdownTable, buildDocumentContent, buildPresentationContent, digestBody } from '../lib/asset-content.js'

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
 *
 * #789② 职责边界：本文件 = 工具描述/参数 schema/asset_type 分发/
 * writeBlock 写回单点；plot 执行在 insert-asset-plot.ts，export 执行在
 * insert-asset-export.ts，渲染管道在 asset-render-pipeline.ts，
 * 纯构建器在 lib/asset-content.ts，图片内嵌在 asset-embed.ts。
 */

export interface InsertAssetContext {
  userId: string
  sessionId?: string
  /** #766: plot/export 渲染需要 execution plane + 对应插件。 */
  executionPlane?: ToolExecutionPlane
  isPluginInstalled?: (pluginId: string) => Promise<boolean>
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
      "asset_type='export': pass format (docx/pptx/pdf). TWO export semantics: (a) organize=false (default) = FAITHFUL export — the CURRENT DRAFT is converted as-is (mechanical '##' → slide/section mapping); requires a non-empty draft, but when the draft is empty and exactly one reference material exists it is auto-imported first. Use when the user says 导出/转 Word/保真导出. (b) organize=true (pptx only) = AI-ORGANIZED deck — the draft is just SOURCE MATERIAL, not the target structure: you read the draft (## Current Document) or the conversation context and PROVIDE the deck content directly in the `slides` argument (aim for 8–15 content slides, max 30; each slide {title, bullets[]}; cover is generated from `title`/`subtitle`). A deck does not require a non-empty draft (素材=对话上下文). If you call organize=true WITHOUT slides, the tool replies with an auto-imported body digest — call it again with slides. Use when the user says 把这篇文章做成 PPT/做个演示.",
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
        organize: { type: 'boolean', description: 'export+pptx only: true = AI 编排做 PPT（你在 slides 参数里直供 deck 内容，正文只是素材）；false/缺省 = 保真导出（草稿机械转换）。' },
        slides: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'slide title (自拟提炼，每页一个主题).' },
              bullets: { type: 'array', items: { type: 'string' }, description: 'bullet 要点；可嵌图片 ![caption](托管URL)（来自正文中的托管图，工具会转内嵌图片块）。' },
            },
            required: ['title'],
          },
          description: 'organize=true: deck 内容直供（建议 8–15 页，契约上限 30）。封面由 title/subtitle 自动生成，不要自己加封面页。',
        },
        subtitle: { type: 'string', description: 'export+organize=true: 封面副标题（可选）。' },
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
      if (assetType === 'plot') {
        if (!this.ctx.executionPlane) {
          return { success: false, error: '执行平面（execution plane）未配置，无法渲染图表。请联系管理员检查 EXECUTION_PLANE_URL / WORKER_API_TOKEN。' }
        }
        return await executeInsertPlot({
          userId: this.ctx.userId,
          docId,
          args,
          plane: this.ctx.executionPlane,
          isPluginInstalled: this.ctx.isPluginInstalled,
          writeBlock: (d, block, a, s) => this.writeBlock(d, block, a, s),
        })
      }
      if (assetType === 'export') {
        if (!this.ctx.executionPlane) {
          return { success: false, error: '执行平面（execution plane）未配置，无法导出。请联系管理员检查 EXECUTION_PLANE_URL / WORKER_API_TOKEN。' }
        }
        return await executeInsertExport({
          userId: this.ctx.userId,
          plane: this.ctx.executionPlane,
          isPluginInstalled: this.ctx.isPluginInstalled,
          writeBlock: (d, block, a, s, opts) => this.writeBlock(d, block, a, s, opts),
        }, docId, args)
      }
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

  // ── 共用写回（#765 管道：快照 + doc_updated）──────────────────
  // #773: opts.deckJson 传入时同帧写入 Doc.deck（快照旧行同帧带旧 deck，
  // body+deck 一致回滚）；opts.snapshotLabel 覆盖快照 label（organize 落
  // deck 用 'AI deck'）。
  private async writeBlock(docId: string, block: string, args: Record<string, unknown>, summaryBase: string, opts: { deckJson?: string | null; snapshotLabel?: string } = {}): Promise<ToolResult> {
    const anchor = typeof args.anchor === 'string' ? args.anchor.trim() : ''
    const existing = await (prisma as any).doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
    if (!existing) return { success: false, error: `Document not found: ${docId}` }
    const body = String(existing.body || '')
    // #789: deck 变更判定保持字符串比较(避免 parse→stringify 键序漂移
    // 造成假阳性快照),变更时才把 deck 交给 DocVersionWriter。
    const deckChanged = opts.deckJson !== undefined && opts.deckJson !== (existing.deck ?? null)
    const nextDeck = deckChanged ? safeParseDeckJson(opts.deckJson) : undefined

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

    // #789: 写回走 DocVersionWriter 单点 — 快照同帧带旧 body+deck 且包
    // 事务(旧代码两段写,快照仅在 deckChanged 时才带旧 deck)。
    if (newBody !== body || deckChanged) {
      const written = await writeDocVersion({
        userId: this.ctx.userId,
        docId,
        body: newBody,
        deck: nextDeck,
        snapshotLabel: opts.snapshotLabel || 'AI insert',
      })
      if (written.error) return { success: false, error: written.error }
    }

    const summary = String(args.summary || `${summaryBase}，${placement}`)
    const output: Record<string, unknown> = { body: newBody, summary }
    // #773: deck JSON 随工具输出返回 — tool-loop 转成 doc_updated.deck 推画布。
    if (opts.deckJson) {
      try { output.deck = JSON.parse(opts.deckJson) } catch { /* ignore */ }
    }
    return { success: true, output: JSON.stringify(output) }
  }
}
