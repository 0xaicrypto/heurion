import { BaseTool, ToolResult } from './base-tool.js'
import prisma from '../common/prisma.js'

/**
 * §15.4/#171 — edit_document: the conversational-writing write-back tool.
 * The AI returns the COMPLETE new document (markdown); the tool persists it
 * (versioned + auto snapshot) and returns the new body for the UI to apply.
 */
export class EditDocumentTool extends BaseTool {
  constructor(private ctx: { userId: string; sessionId?: string }) {
    super()
  }

  get name(): string { return 'edit_document' }

  get description(): string {
    return 'Write the complete updated document content (markdown). The document being edited is identified by the current writing session. Use this instead of explaining changes.'
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        full_text: { type: 'string', description: 'The complete new document content in markdown.' },
        summary: { type: 'string', description: 'A one-line summary of what changed.' },
      },
      required: ['full_text'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const fullText = String(args.full_text || '')
    if (!fullText.trim()) return { success: false, error: 'full_text is required' }

    const sessionId = this.ctx.sessionId || ''
    if (!sessionId.startsWith('doc-')) {
      return { success: false, error: 'edit_document is only available in a document writing session' }
    }
    const docId = sessionId.slice(4)

    try {
      const existing = await (prisma as any).doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
      if (!existing) return { success: false, error: `Document not found: ${docId}` }

      const now = new Date().toISOString()
      // Versioned write-back + auto snapshot (restorable).
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
        output: JSON.stringify({ body: fullText, summary: String(args.summary || 'document updated') }),
      }
    } catch (err) {
      return { success: false, error: `edit_document failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}
