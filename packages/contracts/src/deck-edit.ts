/**
 * #1101（pptx 字节单一标准）— edit_deck_bytes 工具动作 schema。
 *
 * AI 编辑引擎 = pptx-viewer-core 正式函数 API（spike #1102 实测 GO）：
 * findText / replaceText / Presentation builder。spike 黄金教训：对
 * PptxElement.text 直接赋值不被 save 管道识别（text/textSegments 双字段）
 * — AI 只产结构化 actions，服务端逐一映射为正式 API 调用，绝不裸改模型字段。
 *
 * 与已退役的卡片流 edit_deck old_text/new_text 语义同构（§4.1）：`find` = 模型从投影
 * 上下文逐字复制的原文；`replace` = 新文本。schema 见
 * docs/design/DECK_PPTX_SINGLE_STANDARD.md §4。
 */
import { z } from 'zod'

/** 页面轴（1-based；add_slide.afterIndex 允许 0 = 首页之前）。 */
const slideIndexSchema = z.number().int().min(1).max(200).describe('1-based slide index')

/** 单个编辑动作 — 判别联合（op）。zod v3 的 discriminatedUnion 只接受裸
 * ZodObject 选项，scope 一致性校验在下方 superRefine 统一挂（语义等价于
 * 逐支 refine）。 */
const deckEditActionUnion = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('set_text'),
    /** 原文（从投影上下文逐字复制，≥1 字符防空匹配）。 */
    find: z.string().min(1).max(500),
    /** 替换文本（空串 = 删除文本）。 */
    replace: z.string().max(20000),
    /** 缺省 'all' = 全 deck 替换；'slide' 限定第 slideIndex 页。 */
    scope: z.enum(['all', 'slide']).optional(),
    /** scope='slide' 时必填（1-based）。 */
    slideIndex: slideIndexSchema.optional(),
  }),
  z.object({
    op: z.literal('set_notes'),
    slideIndex: slideIndexSchema,
    /** speaker notes（空串 = 清空）。 */
    text: z.string().max(5000),
  }),
  z.object({
    op: z.literal('add_slide'),
    /** 插到第 afterIndex 页之后（0 = 首页之前；1-based deck 页面轴）。 */
    afterIndex: z.number().int().min(0).max(200),
    title: z.string().max(500).optional(),
    bullets: z.array(z.string().max(2000)).max(50).optional(),
  }),
  z.object({
    op: z.literal('remove_slide'),
    slideIndex: slideIndexSchema,
  }),
  z.object({
    op: z.literal('move_slide'),
    from: slideIndexSchema,
    /** 目标位置（1-based）。 */
    to: slideIndexSchema,
  }),
])

export const deckEditActionSchema = deckEditActionUnion.superRefine((a, ctx) => {
  if (a.op === 'set_text' && a.scope === 'slide' && a.slideIndex === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['slideIndex'],
      message: "set_text with scope='slide' requires slideIndex (1-based)",
    })
  }
})

/** 一次调用最多 30 个动作（契约上限，防单回合超长事务）。 */
export const deckEditActionsSchema = z.object({
  actions: z.array(deckEditActionSchema).min(1).max(30),
})

export type DeckEditAction = z.infer<typeof deckEditActionSchema>
export type DeckEditActions = z.infer<typeof deckEditActionsSchema>
