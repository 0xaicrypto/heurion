import { BaseTool, ToolResult } from './base-tool.js'
import prisma from '../common/prisma.js'
import { validateRenderContent } from '@heurion/contracts'
import { SCHEMA_VERSION } from '@heurion/contracts'
import { writeDocVersion } from './doc-version-writer.js'

/**
 * #773 — edit_deck: deck 资产（Doc.deck）的 AI 编辑工具。
 *
 * deck 是 AI 编排产物（insert_asset export organize=true 落 Doc.deck），
 * 独立于文章正文（body）— 编辑 deck 不污染原文。画布 deck 视图每页
 * 可编辑（web 端直接写 Doc.deck），本工具提供 AI 编辑路径：
 * - update：改第 N 页的标题/要点（slide_index 1-based）
 * - delete：删除第 N 页
 * - insert_after：在第 N 页后插入新页
 *
 * 与 edit_document 同管道：快照（label 'AI deck edit'，同帧带旧 deck）+
 * doc_updated（deck 字段随帧推画布）。模型注入面只保留摘要（tool-loop
 * DOC_WRITE_TOOLS），deck JSON 不进上下文。
 */
export class EditDeckTool extends BaseTool {
  constructor(private ctx: { userId: string; sessionId?: string }) {
    super()
  }

  get name(): string { return 'edit_deck' }

  get description(): string {
    return [
      'Edit the AI-organized deck (PPT asset) of the current writing session — the deck is separate from the document body (editing it never touches the summary text).',
      'Requires an existing deck (generated via insert_asset export organize=true, or uploaded PPT).',
      "Actions: 'update' = replace slide N's title/bullets; 'delete' = remove slide N; 'insert_after' = insert a new slide after slide N.",
      'slide_index is 1-based. See ## Current Deck in the context for the current deck content.',
      'Use when the user asks to modify/reorder/remove slides of the organized deck (把第 3 页拆成两页 / 删掉结论页 / 改第 2 页标题). Do NOT use edit_document for deck changes.',
    ].join(' ')
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['update', 'delete', 'insert_after'], description: 'Deck edit action.' },
        slide_index: { type: 'number', description: '1-based slide number to operate on.' },
        title: { type: 'string', description: 'update/insert_after: new slide title.' },
        bullets: { type: 'array', items: { type: 'string' }, description: 'update/insert_after: new bullet lines (may embed ![caption](hosted URL) images).' },
        summary: { type: 'string', description: 'A one-line summary of what changed.' },
      },
      required: ['action', 'slide_index'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = this.ctx.sessionId || ''
    if (!sessionId.startsWith('doc-')) {
      return { success: false, error: 'edit_deck is only available in a document writing session' }
    }
    const docId = sessionId.slice(4)
    const action = String(args.action || '')
    if (!['update', 'delete', 'insert_after'].includes(action)) {
      return { success: false, error: 'action 必须是 update | delete | insert_after' }
    }
    const slideIndex = Number(args.slide_index)
    if (!Number.isInteger(slideIndex) || slideIndex < 1) {
      return { success: false, error: 'slide_index 必须是 ≥1 的整数（1-based）' }
    }

    try {
      const existing = await (prisma as any).doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
      if (!existing) return { success: false, error: `Document not found: ${docId}` }
      if (!existing.deck) {
        return { success: false, error: '当前文档没有 deck（AI 编排产物）。请先用 insert_asset 的 export+organize 生成 deck，再编辑。' }
      }
      let deck: any
      try { deck = JSON.parse(existing.deck) } catch { return { success: false, error: 'deck 数据损坏（无法解析），请重新编排生成。' } }
      const slides: any[] = Array.isArray(deck.slides) ? [...deck.slides] : []
      if (slideIndex > slides.length) {
        return { success: false, error: `slide_index ${slideIndex} 超出范围（当前共 ${slides.length} 页）` }
      }

      const title = String(args.title || '').trim().slice(0, 500)
      const rawBullets = Array.isArray(args.bullets) ? args.bullets : []
      const bullets = rawBullets.map((b: unknown) => String(b ?? '').trim()).filter(Boolean).slice(0, 50)

      if (action === 'delete') {
        if (slides.length <= 1) return { success: false, error: '至少保留 1 页，不能删除最后一页。' }
        slides.splice(slideIndex - 1, 1)
      } else {
        if (!title) return { success: false, error: `${action} 需要 title` }
        if (bullets.length === 0) return { success: false, error: `${action} 需要 bullets（至少 1 条要点）` }
        const slide = {
          title,
          content: bullets.map((b: string) => ({ type: 'paragraph', text: b.slice(0, 2000), style: 'bullet' })),
        }
        if (action === 'update') slides[slideIndex - 1] = slide
        else slides.splice(slideIndex, 0, slide)
      }
      if (slides.length > 30) return { success: false, error: 'deck 最多 30 页（契约上限）。' }

      const nextDeck = { ...deck, schemaVersion: deck.schemaVersion ?? SCHEMA_VERSION, slides }
      const check = validateRenderContent('sidecar.generate_pptx', nextDeck)
      if (!check.ok) return { success: false, error: `编辑后的 deck 未通过契约校验：${check.errors.join('；')}` }

      // #789: 写回走 DocVersionWriter 单点(快照同帧带旧 body+deck + 事务;
      // deck 无实际变化时不再产生空快照 — 旧代码无条件写版本)。
      const written = await writeDocVersion({
        userId: this.ctx.userId, docId, deck: nextDeck, snapshotLabel: 'AI deck edit',
      })
      if (written.error) return { success: false, error: written.error }

      const summary = String(args.summary || `已${action === 'update' ? '更新' : action === 'delete' ? '删除' : '插入'}第 ${slideIndex} 页（现共 ${slides.length} 页）；文章正文未改动`)
      return { success: true, output: JSON.stringify({ body: written.body, deck: nextDeck, summary }) }
    } catch (err) {
      return { success: false, error: `edit_deck failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}
