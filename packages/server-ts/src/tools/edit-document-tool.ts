import { BaseTool, ToolResult } from './base-tool.js'
import prisma from '../common/prisma.js'

/**
 * §15.4/#171 — edit_document: the conversational-writing write-back tool.
 *
 * 两种模式:
 * - range 模式(old_text + new_text):局部编辑 — 在文档中精确替换一个
 *   原文片段。长文档分步润色靠它:一次改一段,用户确认后继续下一段,
 *   模型永远不需要把整篇文档重写一遍(输出 token 上限之外)。
 * - full 模式(full_text):全量替换(旧行为),仅适合短文档整体修改。
 *
 * 版本化 + 自动快照 + 前端 diff 审阅(doc_updated SSE)对两种模式一致。
 */
export class EditDocumentTool extends BaseTool {
  constructor(private ctx: { userId: string; sessionId?: string }) {
    super()
  }

  get name(): string { return 'edit_document' }

  get description(): string {
    return [
      'Edit the current writing-session document. Two modes:',
      '- Range edit (preferred for polishing long documents): pass `old_text` (the EXACT original text to replace, copied verbatim from the current document) and `new_text` (the replacement). One edit per call; make multiple calls to edit multiple parts.',
      '- Full rewrite: pass `full_text` (complete new document in markdown). Only for short documents or when the user explicitly asks to rewrite the whole document.',
      'Use this instead of explaining changes.',
    ].join(' ')
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        old_text: { type: 'string', description: 'Range mode: the exact original text to replace (must match the current document verbatim). Omit to use full mode.' },
        new_text: { type: 'string', description: 'Range mode: the replacement text (empty to delete).' },
        full_text: { type: 'string', description: 'Full mode: the complete new document content in markdown.' },
        summary: { type: 'string', description: 'A one-line summary of what changed.' },
      },
      required: [],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = this.ctx.sessionId || ''
    if (!sessionId.startsWith('doc-')) {
      return { success: false, error: 'edit_document is only available in a document writing session' }
    }
    const docId = sessionId.slice(4)

    const oldText = typeof args.old_text === 'string' ? args.old_text : ''
    const newText = typeof args.new_text === 'string' ? args.new_text : ''
    const fullText = typeof args.full_text === 'string' ? args.full_text : ''

    // #fix: 分步编辑 — 提供了 old_text 就走局部替换,不要求完整文档。
    if (oldText) {
      if (!oldText.trim()) return { success: false, error: 'old_text is empty' }
      return this.rangeEdit(docId, oldText, newText, String(args.summary || 'range edit'))
    }

    if (!fullText.trim()) {
      return { success: false, error: 'Provide old_text+new_text for a range edit, or full_text for a full rewrite.' }
    }
    return this.fullReplace(docId, fullText, String(args.summary || 'document updated'))
  }

  /** 局部编辑:在文档中精确匹配 oldText 并替换为 newText。 */
  private async rangeEdit(docId: string, oldText: string, newText: string, summary: string): Promise<ToolResult> {
    try {
      const existing = await (prisma as any).doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
      if (!existing) return { success: false, error: `Document not found: ${docId}` }

      const body = String(existing.body || '')
      const first = body.indexOf(oldText)
      if (first === -1) {
        // 帮助模型修正锚点:给出文档开头附近的可匹配片段。
        const probe = body.slice(0, 400).replace(/\s+/g, ' ').slice(0, 120)
        return {
          success: false,
          error: `old_text 在文档中未找到,请从当前文档中逐字复制待修改的原文(注意空格/标点)。文档开头附近是: "${probe}"`,
        }
      }
      const second = body.indexOf(oldText, first + oldText.length)
      if (second !== -1) {
        return {
          success: false,
          error: 'old_text 在文档中出现多次,请包含更多上下文让锚点唯一(比如加上前后句)',
        }
      }

      const newBody = body.slice(0, first) + newText + body.slice(first + oldText.length)
      if (newBody === body) return { success: false, error: 'old_text 与 new_text 相同,没有任何变化' }

      const now = new Date().toISOString()
      await (prisma as any).docSnapshot.create({
        data: { docId, userId: this.ctx.userId, body, label: 'AI edit', createdAt: now },
      })
      await (prisma as any).doc.update({
        where: { id: docId },
        data: { body: newBody, updatedAt: now },
      })

      return {
        success: true,
        output: JSON.stringify({ body: newBody, summary }),
      }
    } catch (err) {
      return { success: false, error: `edit_document failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }

  /** 全量替换(旧行为,仅短文档)。 */
  private async fullReplace(docId: string, fullText: string, summary: string): Promise<ToolResult> {
    try {
      const existing = await (prisma as any).doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
      if (!existing) return { success: false, error: `Document not found: ${docId}` }

      const now = new Date().toISOString()
      if (existing.body !== fullText) {
        await (prisma as any).docSnapshot.create({
          data: { docId, userId: this.ctx.userId, body: existing.body, label: 'AI edit', createdAt: now },
        })
      }
      await (prisma as any).doc.update({
        where: { id: docId },
        data: { body: fullText, updatedAt: now },
      })

      return {
        success: true,
        output: JSON.stringify({ body: fullText, summary }),
      }
    } catch (err) {
      return { success: false, error: `edit_document failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}
