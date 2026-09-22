import { BaseTool, ToolResult } from './base-tool.js'
import prisma from '../common/prisma.js'
import { validateRenderContent, SCHEMA_VERSION, slideLayoutSchema, deckThemeSchema, chartBlockSchema } from '@heurion/contracts'
import { writeDocVersion } from './doc-version-writer.js'
import { looksLikeHandwrittenReferences, HANDWRITTEN_REFERENCES_GUIDANCE } from './citation-guard.js'
// #1101 复审轮 1: 双写收敛 — 文档已迁移 pptx 字节工件时 edit_deck 退役。

/**
 * #773 — edit_deck: deck 资产（Doc.deck）的 AI 编辑工具。
 *
 * deck 是 AI 编排产物（insert_asset export organize=true 落 Doc.deck），
 * 独立于文档正文（body）— 编辑 deck 不污染原文。画布 deck 视图每页
 * 可编辑（web 端直接写 Doc.deck），本工具提供 AI 编辑路径：
 * - update：改第 N 页的标题/要点（slide_index 1-based）
 * - delete：删除第 N 页
 * - insert_after：在第 N 页后插入新页
 * #960 deck v2 布局/主题/图表能力（contracts slideLayout/deckTheme/chart）：
 * - set_layout：设置第 N 页布局母版（title/section/bullets/bullets+image/chart-full/quote/blank）
 * - set_theme：deck 级主题（clinical | warm-paper）
 * - move：把第 N 页移动到第 M 位
 * - insert_chart：在第 N 页后插入结构化图表（spec 走契约校验，渲染确定性
 *   #176 管线 — 临床图表禁止生成式模型，AI 只产结构化 spec）
 *
 * 与 edit_document 同管道：快照（label 'AI deck edit'，同帧带旧 deck）+
 * doc_updated（deck 字段随帧推画布）。模型注入面只保留摘要（tool-loop
 * DOC_WRITE_TOOLS），deck JSON 不进上下文。
 *
 * #1101 复审轮 1（双写收敛）：文档已迁移为 pptx 字节工件（deckArtifactId
 * 在场且可读）→ 本工具整体退役拒绝并引导 edit_deck_bytes — DeckWire 是
 * 只读投影（设计 §3.1），绝不给旧 index-based 路径对真相源的残余写入口。
 * 仅存量「无工件纯投影」文档保持 legacy 行为。
 */
export class EditDeckTool extends BaseTool {
  constructor(private ctx: { userId: string; sessionId?: string }) {
    super()
  }

  get name(): string { return 'edit_deck' }

  get description(): string {
    return [
      'LEGACY (only for docs without a pptx artifact): edit the AI-organized deck (DeckWire JSON projection) of the current writing session — the deck is separate from the document body.',
      'Refuses when the deck has been migrated to a pptx artifact (rich editing) — use edit_deck_bytes instead (structured actions: set_text/set_chart_data/set_table_data/add_slide etc.).',
      "Actions: 'update' = replace slide N's title/bullets; 'delete' = remove slide N; 'insert_after' = insert a new slide after slide N.",
      '#960 v2 actions: set_layout (slide_index + layout enum) sets the slide layout master; set_theme (theme: clinical|warm-paper) sets the deck-wide theme; move (slide_index = from, to = target position) reorders slides; insert_chart (slide_index + chart spec {chart_type: line|bar|dose_curve, data: [{label, value}], errors?, sig?, title?, x_label?, y_label?}) inserts a structured chart slide rendered deterministically (never fabricate data — cite the source numbers in the spec).',
      'slide_index is 1-based. See ## Current Deck in the context for the current deck content.',
      'Use when the user asks to modify/reorder/remove slides or adjust slide layout/theme of the organized deck (把第 3 页拆成两页 / 删掉结论页 / 改第 2 页标题 / 给第 2 页换布局 / 整体换成暖色纸面主题 / 插一页柱状图对比两组 PFS). Do NOT use edit_document for deck changes; prefer edit_deck_bytes when available.',
    ].join(' ')
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['update', 'delete', 'insert_after', 'set_layout', 'set_theme', 'move', 'insert_chart'],
          description: 'Deck edit action (legacy: refuses when the deck has a pptx artifact — use edit_deck_bytes).',
        },
        slide_index: { type: 'number', description: '1-based slide number. Required for update/delete/insert_after/set_layout/move(from)/insert_chart; not required for set_theme. Legacy path only — refused when the deck has a pptx artifact (use edit_deck_bytes).' },
        to: { type: 'number', description: "move: target 1-based position." },
        title: { type: 'string', description: 'update/insert_after: new slide title.' },
        bullets: { type: 'array', items: { type: 'string' }, description: 'update/insert_after: new bullet lines (may embed ![caption](hosted URL) images). insert_chart: optional bullets appended after the chart.' },
        layout: { type: 'string', enum: ['title', 'section', 'bullets', 'bullets+image', 'chart-full', 'quote', 'blank'], description: 'set_layout: layout master.' },
        theme: { type: 'string', enum: ['clinical', 'warm-paper'], description: 'set_theme: deck theme.' },
        chart: {
          type: 'object',
          description: 'insert_chart: structured chart spec (deterministic rendering — provide the real numbers, never fabricated).',
          properties: {
            chart_type: { type: 'string', enum: ['line', 'bar', 'dose_curve'] },
            data: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' } }, required: ['label', 'value'] } },
            errors: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, error: { type: 'number' } } } },
            sig: { type: 'object', properties: { pair: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 }, stars: { type: 'string' }, p: { type: 'string' } } },
            title: { type: 'string' },
            x_label: { type: 'string' },
            y_label: { type: 'string' },
          },
        },
        summary: { type: 'string', description: 'A one-line summary of what changed.' },
      },
      required: ['action'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = this.ctx.sessionId || ''
    if (!sessionId.startsWith('doc-')) {
      return { success: false, error: 'edit_deck is only available in a document writing session' }
    }
    const docId = sessionId.slice(4)
    // #1101 复审轮 1（双写收敛）：文档已迁移为 pptx 字节工件（DeckWire 降级为
    // 只读投影，设计 §3.1）→ edit_deck 退役，整次拒绝并引导到 edit_deck_bytes。
    // 刻意在任何参数校验/写回之前 — 不给旧路径对真相源的残余写入口。
    // #1101 复审轮 2 修复（fail-closed）: 拒绝判定只看 Doc.deckArtifactId 指针
    // — 不做 getDeckArtifact 的文件可读性探测（其异常曾被兜底 catch 吞掉，
    // 把分叉口子在异常路径上重新捅开）。工件文件暂不可读时 legacy 路径同样
    // 错误 — edit_deck_bytes 会报同样的读取错误，语义一致；查询失败原样上抛。
    const existing = await prisma.doc.findFirst({
      where: { id: docId, userId: this.ctx.userId },
      select: { deckArtifactId: true },
    })
    if (existing?.deckArtifactId) {
      return {
        success: false,
        error: '该 deck 已迁移为 pptx 字节工件（富编辑），edit_deck 已退役 — 请使用 edit_deck_bytes 工具（结构化动作：set_text/set_chart_data/set_table_data/add_slide 等）',
      }
    }
    const action = String(args.action || '')
    if (!['update', 'delete', 'insert_after', 'set_layout', 'set_theme', 'move', 'insert_chart'].includes(action)) {
      return { success: false, error: 'action 必须是 update | delete | insert_after | set_layout | set_theme | move | insert_chart' }
    }
    const slideIndex = Number(args.slide_index)
    if (action !== 'set_theme') {
      if (!Number.isInteger(slideIndex) || slideIndex < 1) {
        return { success: false, error: 'slide_index 必须是 ≥1 的整数（1-based）' }
      }
    }

    try {
      const existing = await prisma.doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
      if (!existing) return { success: false, error: `Document not found: ${docId}` }
      if (!existing.deck) {
        return { success: false, error: '当前文档没有 deck（AI 编排产物）。请先用 insert_asset 的 export+organize 生成 deck，再编辑。' }
      }
      let deck: any
      try { deck = JSON.parse(existing.deck) } catch { return { success: false, error: 'deck 数据损坏（无法解析），请重新编排生成。' } }
      const slides: any[] = Array.isArray(deck.slides) ? [...deck.slides] : []
      if (action !== 'set_theme' && slideIndex > slides.length) {
        return { success: false, error: `slide_index ${slideIndex} 超出范围（当前共 ${slides.length} 页）` }
      }

      const title = String(args.title || '').trim().slice(0, 500)
      const rawBullets = Array.isArray(args.bullets) ? args.bullets : []
      const bullets = rawBullets.map((b: unknown) => String(b ?? '').trim()).filter(Boolean).slice(0, 50)

      // #1079（复审 #3 修复）: deck 写入同样接入引用纪律守卫 — 模型不得在
      // slides 的 title/bullets 里手写编号引用列表（与 edit_document 同一门控；
      // insert_citation 在 deck 会话同样可用，写 [cite:id] 标记照常放行）。
      // insert_chart 的 chart spec 数据标注不走本守卫（spec 是结构化数据）。
      if (action === 'update' || action === 'insert_after') {
        const deckText = [title, ...bullets].join('\n')
        if (looksLikeHandwrittenReferences(deckText)) {
          return { success: false, error: HANDWRITTEN_REFERENCES_GUIDANCE }
        }
      }

      if (action === 'delete') {
        if (slides.length <= 1) return { success: false, error: '至少保留 1 页，不能删除最后一页。' }
        slides.splice(slideIndex - 1, 1)
      } else if (action === 'update' || action === 'insert_after') {
        if (!title) return { success: false, error: `${action} 需要 title` }
        if (bullets.length === 0) return { success: false, error: `${action} 需要 bullets（至少 1 条要点）` }
        const slide = {
          title,
          content: bullets.map((b: string) => ({ type: 'paragraph', text: b.slice(0, 2000), style: 'bullet' })),
        }
        if (action === 'update') slides[slideIndex - 1] = slide
        else slides.splice(slideIndex, 0, slide)
      } else if (action === 'set_layout') {
        const layout = String(args.layout || '')
        const check = slideLayoutSchema.safeParse(layout)
        if (!check.success) return { success: false, error: 'layout 必须是 title | section | bullets | bullets+image | chart-full | quote | blank' }
        slides[slideIndex - 1] = { ...slides[slideIndex - 1], layout: check.data }
      } else if (action === 'set_theme') {
        const theme = String(args.theme || '')
        const check = deckThemeSchema.safeParse(theme)
        if (!check.success) return { success: false, error: 'theme 必须是 clinical | warm-paper' }
        deck = { ...deck, theme }
      } else if (action === 'move') {
        const to = Number(args.to)
        if (!Number.isInteger(to) || to < 1 || to > slides.length) {
          return { success: false, error: `to 必须是 1~${slides.length} 的整数（1-based 目标位置）` }
        }
        if (to === slideIndex) return { success: false, error: 'to 与当前位置相同，无需移动。' }
        const [moved] = slides.splice(slideIndex - 1, 1)
        slides.splice(to - 1, 0, moved)
      } else if (action === 'insert_chart') {
        const chart = (args.chart ?? null) as Record<string, unknown> | null
        if (!chart) return { success: false, error: 'insert_chart 需要 chart 参数（{chart_type, data[{label,value}], ...}）。' }
        const blockCheck = chartBlockSchema.safeParse({ type: 'chart', spec: chart })
        if (!blockCheck.success) {
          return { success: false, error: `chart spec 未通过契约校验：${blockCheck.error.issues.map((i) => i.message).join('；').slice(0, 300)}` }
        }
        const newSlide = {
          title: title || String(chart.title || '图表').slice(0, 500),
          layout: 'chart-full',
          content: [
            { type: 'chart', spec: chart, caption: (String(args.summary || '') || undefined) as string | undefined },
            ...bullets.map((b: string) => ({ type: 'paragraph', text: b.slice(0, 2000), style: 'bullet' })),
          ],
        }
        slides.splice(slideIndex, 0, newSlide)
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

      const ACTION_LABEL: Record<string, string> = {
        update: '更新', delete: '删除', insert_after: '插入',
        set_layout: '设置布局', set_theme: '设置主题', move: '移动', insert_chart: '插入图表',
      }
      const summary = String(args.summary || `已${ACTION_LABEL[action] || action}${action === 'set_theme' ? '' : ` 第 ${slideIndex} 页`}（现共 ${slides.length} 页）；正文未改动`)
      // #989 Phase 3: 输出携带块投影 — tool-loop 转 doc_updated.projection 推前端。
      return { success: true, output: JSON.stringify({ body: written.body, deck: nextDeck, summary, projection: written.projection }) }
    } catch (err) {
      return { success: false, error: `edit_deck failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}
