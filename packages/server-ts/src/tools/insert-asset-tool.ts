import { BaseTool, ToolResult } from './base-tool.js'
import prisma from '../common/prisma.js'
import { findNormalizedSpan, findFuzzySpan } from './edit-document-tool.js'

/**
 * #765 — insert_asset: the writing-canvas structured-asset tool (P1: table).
 *
 * 动机（epic #764）：写作 chat 里"根据这段数据做一张 Table 1"类请求此前
 * 只能走前置路由渲染下载文件（旁路），内容与草稿脱节且从不写回正文。
 * 本工具把表格生成收进工具循环：模型自主决定时机与内容，markdown 表格
 * 直接写入 Doc.body，快照 + doc_updated 推画布（与 edit_document 同管道）。
 *
 * 定位复用 edit_document 的三级匹配（空白塌缩 → 忽略空白 → 模糊）：
 * - anchor 命中 → 表格插入锚点片段之后；
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

export class InsertAssetTool extends BaseTool {
  constructor(private ctx: { userId: string; sessionId?: string }) {
    super()
  }

  get name(): string { return 'insert_asset' }

  get description(): string {
    return [
      "Insert a structured asset into the current writing-session document. asset_type='table': pass headers + rows — a markdown table is generated and written into the document.",
      'Optionally pass anchor (a text fragment copied VERBATIM from the current document; whitespace/line-break differences are tolerated) to place the table right AFTER that fragment. Without a match (or without anchor) the table is appended at the end.',
      "Use this when the user asks for a table in the draft (Table 1, 基线特征表, 结果表格, 表格…) — do NOT paste raw markdown tables yourself and do NOT use edit_document for this.",
    ].join(' ')
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        asset_type: { type: 'string', enum: ['table'], description: 'Asset type. Currently: table.' },
        headers: { type: 'array', items: { type: 'string' }, description: 'Column headers (table).' },
        rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Table rows, each an array of cell strings aligned with headers.' },
        caption: { type: 'string', description: 'Optional caption rendered as a bold line above the table (e.g. "Table 1. Baseline characteristics").' },
        anchor: { type: 'string', description: 'Optional: verbatim fragment from the current document; the table is inserted right after it. Omit to append at the end.' },
        summary: { type: 'string', description: 'A one-line summary of what was inserted.' },
      },
      required: ['asset_type', 'headers', 'rows'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = this.ctx.sessionId || ''
    if (!sessionId.startsWith('doc-')) {
      return { success: false, error: 'insert_asset is only available in a document writing session' }
    }
    const docId = sessionId.slice(4)

    const assetType = String(args.asset_type || 'table')
    if (assetType !== 'table') {
      return { success: false, error: `Unsupported asset_type: ${assetType}（当前仅支持 table）` }
    }
    const headers = Array.isArray(args.headers) ? args.headers.map((h) => String(h)) : []
    const rows = Array.isArray(args.rows) ? args.rows.map((r) => (Array.isArray(r) ? r.map((c) => String(c)) : [String(r)])) : []
    if (headers.length === 0) return { success: false, error: 'headers 不能为空' }
    if (rows.length === 0) return { success: false, error: 'rows 不能为空' }
    const caption = typeof args.caption === 'string' ? args.caption.trim() : ''
    const anchor = typeof args.anchor === 'string' ? args.anchor.trim() : ''

    const table = buildMarkdownTable(headers, rows)
    const block = caption ? `**${caption}**\n\n${table}` : table

    try {
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
          placement = '锚点未命中，已追加文末（可提示用户表格位置）'
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

      const summary = String(args.summary || `已插入表格（${rows.length} 行 × ${headers.length} 列），${placement}`)
      return { success: true, output: JSON.stringify({ body: newBody, summary }) }
    } catch (err) {
      return { success: false, error: `insert_asset failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}
