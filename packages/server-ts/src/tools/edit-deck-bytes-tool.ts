import { BaseTool, ToolResult } from './base-tool.js'
import prisma from '../common/prisma.js'
import { deckEditActionsSchema, type DeckEditAction } from '@heurion/contracts'
import { parseDocSessionId } from './tool-registry.js'
import { looksLikeHandwrittenReferences, HANDWRITTEN_REFERENCES_GUIDANCE } from './citation-guard.js'
import {
  getDeckArtifact,
  putDeckArtifact,
  serializeDeckWireToPptx,
} from '../lib/deck-bytes.js'

/**
 * #1101（pptx 字节单一标准）— edit_deck_bytes：deck pptx 工件的 AI 编辑工具。
 *
 * 编辑引擎 = pptx-viewer-core **正式函数 API**（spike #1102 GO 实测）：
 * Presentation.load(字节) → findText/replaceText/replaceTextOnSlide →
 * Presentation.insertSlide/removeSlide/moveSlide → save → putDeckArtifact
 * （新工件落 FileIndex → extractor 重建 Doc.deck 投影 → writeDocVersion
 * 快照 'deck bytes'，writeSource 'ai'）。
 *
 * spike 黄金教训（#1102）：对 PptxElement.text 直接赋值**不被 save 管道
 * 识别**（text/textSegments 双字段）— 模型只产结构化 actions（contracts
 * deckEditActionSchema 校验），服务端逐一映射为正式 API 调用，绝不裸改
 * 模型字段。`find` 语义 = edit_deck 的 old_text 同源（从投影上下文逐字复制）。
 *
 * 与旧 edit_deck（index-based DeckWire 编辑）的关系：DeckWire 降级为只读
 * 投影（设计 §4），本工具是 deck 编辑的字节路径；存量「有 DeckWire 无
 * 工件」文档首次调用时自动 bootstrap（serializeDeckWireToPptx 转字节落
 * 工件），此后一切编辑基于字节。
 *
 * 引用纪律（#1079 同门控）：set_text 的 replace 先过
 * looksLikeHandwrittenReferences — 命中 → 整次调用拒绝（不落任何动作，
 * HANDWRITTEN_REFERENCES_GUIDANCE 纠偏）；insert_citation 产 [cite:id]
 * 标记照常放行。
 */
export class EditDeckBytesTool extends BaseTool {
  constructor(private ctx: { userId: string; sessionId?: string }) {
    super()
  }

  get name(): string { return 'edit_deck_bytes' }

  get description(): string {
    return [
      'Edit the deck (PPT artifact) of the current writing session via structured actions applied to the underlying pptx file.',
      'Requires a deck artifact (an existing deck, or a legacy deck JSON that is auto-converted on first use).',
      'Each action is one of: { op: "set_text", find, replace, scope?: "all"|"slide", slideIndex? } — find is copied VERBATIM from the Current Deck context (same semantics as old_text); empty replace deletes the text.',
      '{ op: "set_notes", slideIndex, text } sets speaker notes for slide N.',
      '{ op: "add_slide", afterIndex, title?, bullets? } inserts a new slide after position afterIndex (0 = very first).',
      '{ op: "remove_slide", slideIndex } removes slide N (at least 1 slide must remain).',
      '{ op: "move_slide", from, to } reorders slide from-position to to-position.',
      'slideIndex/afterIndex/from/to are 1-based (afterIndex may be 0). Indices refer to the CURRENT deck state as earlier actions in the same call are applied in order.',
      'The deck is edited as a real pptx file: untouched slides/elements are preserved bit-for-bit. Use when the user asks to modify deck slide text/notes/order (把第 2 页里的 87 例改成 120 例 / 改备注 / 插一页 / 删掉结论页 / 把第 3 页移到第 1 页). Do NOT use edit_document for deck changes; do NOT hand-write numbered reference lists in deck text (use insert_citation).',
    ].join(' ')
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: 30,
          description: 'Ordered deck edit actions (applied in sequence, single pptx save).',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set_text', 'set_notes', 'add_slide', 'remove_slide', 'move_slide'] },
              find: { type: 'string', description: 'set_text: original text copied verbatim from the deck (min 1 char).' },
              replace: { type: 'string', description: 'set_text: replacement text (empty string = delete).' },
              scope: { type: 'string', enum: ['all', 'slide'], description: 'set_text: default all slides; slide = only slideIndex.' },
              slideIndex: { type: 'number', description: '1-based slide number (set_notes; set_text scope=slide; remove_slide).' },
              afterIndex: { type: 'number', description: 'add_slide: insert after this 1-based position (0 = before first slide).' },
              title: { type: 'string', description: 'add_slide: new slide title (max 500).' },
              bullets: { type: 'array', items: { type: 'string' }, description: 'add_slide: bullet lines (max 50).' },
              text: { type: 'string', description: 'set_notes: notes text (max 5000, empty = clear).' },
              from: { type: 'number', description: 'move_slide: source 1-based position.' },
              to: { type: 'number', description: 'move_slide: target 1-based position.' },
            },
            required: ['op'],
          },
        },
        summary: { type: 'string', description: 'A one-line summary of what changed.' },
      },
      required: ['actions'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const docId = parseDocSessionId(this.ctx.sessionId || '')
    if (!docId) {
      return { success: false, error: 'edit_deck_bytes is only available in a document writing session' }
    }

    // 契约校验（含 set_text scope/slideIndex 一致性 + 页界/长度上限）。
    const parsed = deckEditActionsSchema.safeParse({ actions: args.actions })
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；').slice(0, 400)
      return { success: false, error: `actions 未通过契约校验：${issues}` }
    }
    const actions = parsed.data.actions

    // #1079 同门控（§4.2）：所有 set_text 的 replace 先过引用纪律护栏 —
    // 命中 → 整次调用拒绝（零动作执行，不留半截编辑）。
    for (const action of actions) {
      if (action.op === 'set_text' && looksLikeHandwrittenReferences(action.replace)) {
        return { success: false, error: HANDWRITTEN_REFERENCES_GUIDANCE }
      }
    }

    try {
      const doc = await prisma.doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
      if (!doc) return { success: false, error: `Document not found: ${docId}` }
      // baseDeck = 调用链所基于的 Doc.deck 原始存储串（本函数读值）—
      // bootstrap 会同帧改写 deck，最终写回必须以 bootstrap 后的值为基线。
      let baseDeckForWrite = doc.deck ?? null

      // 字节真相源：工件优先；存量无工件 + 有 DeckWire → 自动 bootstrap。
      let artifact = await getDeckArtifact(docId)
      if (!artifact && doc.deck) {
        let deckWire: unknown
        try {
          deckWire = JSON.parse(doc.deck)
        } catch {
          return { success: false, error: 'deck 数据损坏（无法解析），且没有 pptx 工件可编辑。请重新编排生成 deck。' }
        }
        const bytes = await serializeDeckWireToPptx(deckWire)
        const put = await putDeckArtifact({
          userId: this.ctx.userId, docId, bytes,
          baseDeck: doc.deck, writeSource: 'ai',
        })
        if (put.conflict) return { success: false, error: put.error || 'deck 工件创建冲突，请重试' }
        if (put.error) return { success: false, error: `deck 工件创建失败：${put.error.slice(0, 200)}` }
        artifact = await getDeckArtifact(docId)
        // bootstrap 已推进 Doc.deck（投影重建）→ 基线随之更新。
        const refreshed = await prisma.doc.findFirst({ where: { id: docId, userId: this.ctx.userId }, select: { deck: true } })
        baseDeckForWrite = refreshed?.deck ?? baseDeckForWrite
      }
      if (!artifact) {
        return { success: false, error: '当前文档没有 deck（pptx 工件）。请先用 insert_asset 的 export+organize 生成 deck，再编辑。' }
      }

      // 加载引擎（正式 API — 绝不裸改 PptxData 字段）。
      const { Presentation } = await import('pptx-viewer-core')
      const pres = await Presentation.load(new Uint8Array(artifact.bytes).buffer)
      try {
        const slideCount = pres.slideCount
        if (slideCount === 0) return { success: false, error: '工件内没有幻灯片（文件损坏），请重新生成 deck。' }

        // 预检动作边界（1-based → 0-based；add_slide 会扩容按当前态校验）。
        const boundsError = precheckBounds(actions, slideCount)
        if (boundsError) return { success: false, error: boundsError }

        const results: Array<{ index: number; op: string; applied: boolean; detail: string }> = []
        let appliedCount = 0

        for (let i = 0; i < actions.length; i += 1) {
          const action = actions[i]
          try {
            switch (action.op) {
              case 'set_text': {
                const count = action.scope === 'slide'
                  ? pres.replaceTextOnSlide((action.slideIndex ?? 1) - 1, action.find, action.replace)
                  : pres.replaceText(action.find, action.replace)
                appliedCount += count > 0 ? 1 : 0
                results.push({
                  index: i + 1, op: 'set_text', applied: count > 0,
                  detail: count > 0
                    ? `替换 ${count} 处（${action.scope === 'slide' ? `第 ${action.slideIndex} 页` : '全 deck'}）`
                    : `未找到「${action.find.slice(0, 50)}」— 请从 ## Current Deck 逐字复制原文`,
                })
                break
              }
              case 'set_notes': {
                const slide = pres.slides[action.slideIndex - 1]
                const before = slide.notes || ''
                slide.notes = action.text // spike #1102 验证：save 管道识别 notes 赋值
                const changed = before !== (action.text || '')
                appliedCount += changed ? 1 : 0
                results.push({ index: i + 1, op: 'set_notes', applied: changed, detail: changed ? `第 ${action.slideIndex} 页备注已更新` : '备注未变化' })
                break
              }
              case 'add_slide': {
                const at = action.afterIndex
                const sb = pres.insertSlide(at)
                const title = action.title?.trim() || `第 ${at + 1} 页`
                sb.addText(title.slice(0, 500), { x: 60, y: 40, width: 1160, height: 90, fontSize: 30, bold: true })
                const bullets = (action.bullets ?? []).map((b) => String(b ?? '').trim()).filter(Boolean).slice(0, 50)
                if (bullets.length > 0) {
                  sb.addText(bullets.map((b) => b.slice(0, 2000)).join('\n'), { x: 60, y: 150, width: 1160, height: 500, fontSize: 18 })
                }
                sb.build()
                appliedCount += 1
                results.push({ index: i + 1, op: 'add_slide', applied: true, detail: `已在第 ${Math.max(at, 1)} 页后插入新页「${title.slice(0, 40)}」` })
                break
              }
              case 'remove_slide': {
                pres.removeSlide(action.slideIndex - 1)
                appliedCount += 1
                results.push({ index: i + 1, op: 'remove_slide', applied: true, detail: `已删除第 ${action.slideIndex} 页` })
                break
              }
              case 'move_slide': {
                if (action.from !== action.to) {
                  pres.moveSlide(action.from - 1, action.to - 1)
                  appliedCount += 1
                  results.push({ index: i + 1, op: 'move_slide', applied: true, detail: `第 ${action.from} 页已移动到第 ${action.to} 页` })
                } else {
                  results.push({ index: i + 1, op: 'move_slide', applied: false, detail: 'from 与 to 相同，无需移动' })
                }
                break
              }
            }
          } catch (err) {
            results.push({ index: i + 1, op: action.op, applied: false, detail: `执行失败：${(err as Error).message.slice(0, 120)}` })
          }
        }

        if (appliedCount === 0) {
          return {
            success: false,
            error: `没有动作生效，工件未保存。逐动作原因：${results.map((r) => `#${r.index} ${r.detail}`).join('；').slice(0, 600)}`,
          }
        }

        const bytes = Buffer.from(await pres.save())

        // 新工件 + 投影重建 + writeDocVersion（AI 路径）— 冲突向上传模型自纠。
        const put = await putDeckArtifact({
          userId: this.ctx.userId, docId, bytes,
          baseDeck: baseDeckForWrite, writeSource: 'ai',
        })
        if (put.conflict) {
          return { success: false, error: put.error || 'deck 已被并发修改，本次编辑基于过期内容被拒绝，请重读后重试' }
        }
        if (put.error) {
          return { success: false, error: `deck 工件写回失败：${put.error.slice(0, 200)}` }
        }

        const summary = String(args.summary || `已应用 ${appliedCount}/${actions.length} 个动作（现共 ${pres.slideCount} 页）；正文未改动`)
        let bodyProjection: unknown = undefined
        if (doc.blockProjection) {
          try { bodyProjection = JSON.parse(doc.blockProjection) } catch { bodyProjection = undefined }
        }
        const output = JSON.stringify({
          body: doc.body,
          summary,
          ...(put.projection ? { deck: JSON.parse(put.projection) } : {}),
          ...(bodyProjection !== undefined ? { projection: bodyProjection } : {}),
          artifact_id: put.artifactId,
          version: put.version,
          actions_applied: appliedCount,
          actions_total: actions.length,
          slides: pres.slideCount,
          results,
        })
        return { success: true, output }
      } finally {
        pres.handler.dispose()
      }
    } catch (err) {
      return { success: false, error: `edit_deck_bytes failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}

/** 动作预检：1-based 页面轴边界（当前态页数 — add_slide 扩容按序累计）。 */
function precheckBounds(actions: DeckEditAction[], slideCount: number): string | null {
  let count = slideCount
  for (const action of actions) {
    switch (action.op) {
      case 'set_text':
        if (action.scope === 'slide' && (action.slideIndex ?? 1) > count) {
          return `slideIndex ${action.slideIndex} 超出范围（当前共 ${count} 页）`
        }
        break
      case 'set_notes':
        if (action.slideIndex > count) return `slideIndex ${action.slideIndex} 超出范围（当前共 ${count} 页）`
        break
      case 'add_slide':
        if (action.afterIndex > count) return `afterIndex ${action.afterIndex} 超出范围（当前共 ${count} 页，0 = 首页之前）`
        if (count >= 30) return 'deck 最多 30 页（契约上限）'
        count += 1
        break
      case 'remove_slide':
        if (action.slideIndex > count) return `slideIndex ${action.slideIndex} 超出范围（当前共 ${count} 页）`
        if (count <= 1) return '至少保留 1 页，不能删除最后一页。'
        count -= 1
        break
      case 'move_slide':
        if (action.from > count || action.to > count) return `from/to 超出范围（当前共 ${count} 页）`
        break
    }
  }
  return null
}
