/**
 * #1039 — 评论（Comment）数据模型与 CRUD API。
 *
 * 路由面（均挂在 doc 归属校验之下 — 跟随现有 doc 相关路由的 404 语义，
 * 不暴露 403 区分「不存在/无权」，避免枚举他人文档）：
 *   POST   /api/v1/docs/:docId/comments               创建评论（含首条内容）
 *   GET    /api/v1/docs/:docId/comments               列表（含 replies；section_id/status 过滤；
 *                                                      #1064 分页 limit/offset + has_more；
 *                                                      #1064 锚点诊断懒计算 — ?with_anchor=1 才算）
 *   POST   /api/v1/docs/:docId/comments/:commentId/replies   追加回复（role: user|ai）
 *   PATCH  /api/v1/docs/:docId/comments/:commentId    切换 status（open/resolved）
 *
 * 数据模型为 sidecar 旁路表（DocComment/DocCommentReply，见 schema.prisma）：
 * 评论锚点绝不塞进正文 — markdown↔html round-trip 会吃掉自定义 mark。
 * anchorText 漂移诊断复用 edit_document 同一套容错（anchor-diagnostics +
 * document-span-match），保证评论重定位与 AI 编辑重定位行为一致。
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DocComment, DocCommentReply } from '@prisma/client'
import { authGuard } from '../../common/auth.guard.js'
import prisma from '../../common/prisma.js'
import { makeLogger } from '../../common/logger.js'
// #1039: 锚点漂移候选建议 — 与 edit_document 共用同一实现（只复用不改）。
import { closestTextCandidates, type AnchorCandidate } from '../../tools/anchor-diagnostics.js'
// #1039: 「当前正文里还能不能定位到」的判定 — 与 edit_document 的两级
// 归一化匹配 + 模糊兜底同口径（空白/markdown 标记差异不算漂移）。
import { findNormalizedSpan, findFuzzySpan } from '../../lib/document-span-match.js'

const log = makeLogger('comments.router')

// ── 校验（zod，跟随 approvals.router 的 safeParse + 400 模式）──

// #1051: 锚点目标 — 可判别联合。'section'（正文节，默认/存量兼容）需要
// section_id；'deck_slide'（deck 幻灯片页）需要 slide_index（1-based，与
// edit_deck 的 slide_index 同口径），section_id 可空，block_index 可选（0-based）。
const createCommentSchema = z
  .object({
    section_id: z.string().min(1).optional(),
    // #1064: 逐字段 cap（对齐仓库 chat.dto 惯例）— anchor_text 2000 / text 10000，
    // 防止单条 ~1MB 写入且 anchorText 每次 GET 参与相似度计算的 CPU 放大。
    anchor_text: z.string().min(1).max(2000),
    // 首条评论内容 — 作为线程第一条 user 回复落库
    text: z.string().min(1).max(10000),
    target: z.enum(['section', 'deck_slide']).default('section'),
    slide_index: z.number().int().min(1).optional(),
    block_index: z.number().int().min(0).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.target === 'section' && !v.section_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['section_id'], message: 'section_id is required for section comments' })
    }
    if (v.target === 'deck_slide' && (v.slide_index === undefined || v.slide_index < 1)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slide_index'], message: 'slide_index is required for deck_slide comments' })
    }
  })

// #1064: role 'ai' 不可由客户端自封 — HTTP 路径只接受 'user'（缺省 user）；
// AI 回复走本模块导出的 appendCommentReplyInternal（服务端内部路径）。
const createReplySchema = z.object({
  role: z.literal('user').default('user'),
  // #1064: 回复内容同样受 cap
  text: z.string().min(1).max(10000),
})

// #1064 集成收口(#1041 web 闭环消费): AI 回复专用入口 — role 服务端固定
// 'ai',body 只收文本;认证 + 归属校验在路由内做,与通用 replies 端点同纪律。
const aiReplySchema = z.object({
  text: z.string().min(1).max(10000),
})

const patchCommentSchema = z.object({
  status: z.enum(['open', 'resolved']),
})

// #1064: 列表分页 + 诊断懒计算 — limit 默认 50 上限 200，offset 偏移；
// with_anchor 仅接受 '0'/'1'（'1' 才跑锚点定位诊断，默认不算）。
const listQuerySchema = z.object({
  section_id: z.string().optional(),
  status: z.enum(['open', 'resolved']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  with_anchor: z.enum(['0', '1']).default('0'),
})

// #923 类型收口:路由参数显式类型(替代 request.params as any)。
interface DocParams { docId: string }
interface CommentParams extends DocParams { commentId: string }

/** 锚点定位诊断 — located=false 时附最接近候选（模型/前端一次修正用）。 */
interface AnchorDiagnosis {
  located: boolean
  candidates?: AnchorCandidate[]
}

interface SerializedReply { id: string; role: string; text: string; created_at: string }

interface SerializedComment {
  id: string
  doc_id: string
  section_id: string | null
  // #1051: 锚点目标判别字段（'section' | 'deck_slide'）
  target: string
  slide_index: number | null
  block_index: number | null
  anchor_text: string
  status: string
  created_by: string
  created_at: string
  resolved_at: string | null
  replies: SerializedReply[]
  anchor?: AnchorDiagnosis
}

function serializeReply(r: DocCommentReply): SerializedReply {
  return { id: r.id, role: r.role, text: r.text, created_at: r.createdAt }
}

function serializeComment(c: DocComment & { replies: DocCommentReply[] }): SerializedComment {
  return {
    id: c.id,
    doc_id: c.docId,
    section_id: c.sectionId || null,
    target: c.target,
    slide_index: c.slideIndex,
    block_index: c.blockIndex,
    anchor_text: c.anchorText,
    status: c.status,
    created_by: c.createdBy,
    created_at: c.createdAt,
    resolved_at: c.resolvedAt,
    replies: c.replies.map(serializeReply),
  }
}

/**
 * #1039: 锚点定位诊断 — 判定与 edit_document 完全同口径：
 * 归一化（空白塌缩/markdown 标记剥离/忽略大小写）精确匹配 + 模糊兜底。
 * 定位不到才算漂移，此时给最接近的候选片段（bigram Dice 相似度排序），
 * 不是裸的「找不到」。
 */
function diagnoseAnchor(anchorText: string, body: string): AnchorDiagnosis {
  const found = findNormalizedSpan(body, anchorText) ?? findFuzzySpan(body, anchorText)
  if (found) return { located: true }
  return { located: false, candidates: closestTextCandidates(body, anchorText, { limit: 3 }) }
}

/**
 * #1051: deck slide 文本拼接 — 标题 + content 块内所有文本行（block 顺序），
 * 作为 deck 评论锚点诊断的宿主文本。定位/候选逻辑与正文共用同一套
 * （findNormalizedSpan / findFuzzySpan / closestTextCandidates），不为 deck 换口径。
 *
 * #1064: ① 接收已解析的 deck 对象（列表侧单次 JSON.parse 复用，不逐评论 parse）；
 * ② table 块（#1047，行列数据在 data JSON 串，contracts tableBlockSchema 形状）
 * 解析出行文本拼接进宿主文本 — 此前表格锚点必然 located=false 误报漂移。
 */
function deckSlideText(deck: { slides?: unknown } | null, slideIndex: number | null | undefined): string | null {
  if (!deck || !slideIndex || slideIndex < 1) return null
  if (!Array.isArray(deck.slides)) return null
  const slide = deck.slides[slideIndex - 1] as { title?: unknown; content?: unknown } | undefined
  if (!slide || typeof slide !== 'object') return null
  const parts: string[] = []
  if (typeof slide.title === 'string' && slide.title.trim()) parts.push(slide.title)
  if (Array.isArray(slide.content)) {
    for (const b of slide.content) {
      if (!b || typeof b !== 'object') continue
      const block = b as { type?: unknown; text?: unknown; data?: unknown }
      // #1064: table 块 — data 为 JSON 字符串 "{ rows: string[][], header? }"，
      // 解析出行文本（单元格 tab 拼接为一行）进宿主文本；损坏 data 跳过不崩溃。
      if (block.type === 'table') {
        if (typeof block.data !== 'string') continue
        try {
          const table = JSON.parse(block.data) as { rows?: unknown }
          if (!Array.isArray(table.rows)) continue
          for (const row of table.rows) {
            if (!Array.isArray(row)) continue
            const cells = row.filter((c): c is string => typeof c === 'string')
            if (cells.length > 0) parts.push(cells.join('\t'))
          }
        } catch {
          // 损坏 data — 跳过该块
        }
        continue
      }
      if (typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : null
}

/** #1064: deck JSON 单次解析 — 列表内所有 deck 评论共用同一份解析结果。 */
function parseDeckSlides(deckRaw: string | null | undefined): { slides?: unknown } | null {
  if (!deckRaw) return null
  try {
    const deck = JSON.parse(deckRaw) as { slides?: unknown }
    return deck && typeof deck === 'object' ? deck : null
  } catch {
    return null
  }
}

/** #1051: deck_slide 锚点诊断 — slide 缺失/越界/损坏 → located=false（不崩溃）。 */
function diagnoseDeckAnchor(anchorText: string, deck: { slides?: unknown } | null, slideIndex: number | null | undefined): AnchorDiagnosis {
  const slideText = deckSlideText(deck, slideIndex)
  if (slideText === null) return { located: false }
  return diagnoseAnchor(anchorText, slideText)
}

/**
 * #1064: 服务端内部回复写入 — role 'ai' 只能走这条路径（供 #1041 评论驱动
 * AI 编辑收口等内部流程调用），HTTP 端点拒绝客户端自封。doc/comment 归属
 * 校验由调用方先行完成（内部函数不做鉴权）。
 */
export async function appendCommentReplyInternal(input: { commentId: string; role: 'user' | 'ai'; text: string }): Promise<SerializedReply> {
  const row = await prisma.docCommentReply.create({
    data: { commentId: input.commentId, role: input.role, text: input.text, createdAt: new Date().toISOString() },
  })
  return serializeReply(row)
}

export async function commentsRouter(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authGuard)

  // ── 创建评论（含首条评论内容 → 线程第一条 user 回复）──
  app.post<{ Params: DocParams; Body: unknown }>('/api/v1/docs/:docId/comments', async (request, reply) => {
    const userId = request.user!.userId
    // 归属校验 — 与 GET/PUT /docs/:docId 同口径（不属于调用者一律 404）
    const doc = await prisma.doc.findFirst({ where: { id: request.params.docId, userId } })
    if (!doc) return reply.status(404).send({ error: 'Document not found' })
    const parsed = createCommentSchema.safeParse(request.body)
    if (!parsed.success) {
      // #1064: 信封统一为仓库主流 { error: parsed.error.format() }（对照 approvals.router）
      return reply.status(400).send({ error: parsed.error.format() })
    }
    const { section_id, anchor_text, text, target, slide_index, block_index } = parsed.data
    const now = new Date().toISOString()
    const comment = await prisma.docComment.create({
      data: {
        docId: doc.id,
        // #1051: deck_slide 评论 sectionId 落空串（判别字段是 target）
        sectionId: section_id ?? '',
        anchorText: anchor_text,
        target,
        ...(target === 'deck_slide' ? { slideIndex: slide_index, ...(block_index !== undefined ? { blockIndex: block_index } : {}) } : {}),
        status: 'open',
        createdBy: userId,
        createdAt: now,
        replies: { create: { role: 'user', text, createdAt: now } },
      },
      include: { replies: true },
    })
    return reply.status(201).send(serializeComment(comment))
  })

  // ── 评论列表（含 replies；section_id/status 过滤；open 评论附锚点诊断）──
  app.get<{ Params: DocParams; Querystring: unknown }>('/api/v1/docs/:docId/comments', async (request, reply) => {
    const userId = request.user!.userId
    const doc = await prisma.doc.findFirst({
      where: { id: request.params.docId, userId },
      // #1051: deck 评论锚点诊断需要 Doc.deck
      select: { id: true, body: true, deck: true },
    })
    if (!doc) return reply.status(404).send({ error: 'Document not found' })
    const query = listQuerySchema.safeParse(request.query)
    if (!query.success) {
      // #1064: 信封统一为仓库主流 { error: parsed.error.format() }
      return reply.status(400).send({ error: query.error.format() })
    }
    // #1064: 分页 — skip/take 多取 1 条判 has_more（免额外 count 查询）
    const comments = await prisma.docComment.findMany({
      where: {
        docId: doc.id,
        ...(query.data.section_id ? { sectionId: query.data.section_id } : {}),
        ...(query.data.status ? { status: query.data.status } : {}),
      },
      // 线程时间序 — id 副键稳定同毫秒创建的次序（cuid 同毫秒单调）
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { replies: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
      skip: query.data.offset,
      take: query.data.limit + 1,
    })
    const hasMore = comments.length > query.data.limit
    if (hasMore) comments.pop()
    // #1064: 诊断懒计算 — 默认不算（列表页省 CPU），?with_anchor=1 才跑；
    // deck JSON 单次解析，列表内所有 deck_slide 评论复用，不逐评论 parse。
    const withAnchor = query.data.with_anchor === '1'
    const deckParsed = withAnchor ? parseDeckSlides(doc.deck) : null
    const body = String(doc.body || '')
    return {
      comments: comments.map((c) => {
        const out = serializeComment(c)
        // #1039: 只对 open 评论跑定位诊断 — resolved 线程已完结，不再重定位。
        // #1064: 默认不跑；?with_anchor=1 时诊断（#1051 deck_slide 用 Doc.deck）。
        if (withAnchor && c.status === 'open') {
          out.anchor = c.target === 'deck_slide'
            ? diagnoseDeckAnchor(c.anchorText, deckParsed, c.slideIndex)
            : diagnoseAnchor(c.anchorText, body)
        }
        return out
      }),
      // #1064: 分页元信息
      limit: query.data.limit,
      offset: query.data.offset,
      has_more: hasMore,
    }
  })

  // ── 追加回复（role 区分 user/ai，按时间序追加进线程）──
  app.post<{ Params: CommentParams; Body: unknown }>('/api/v1/docs/:docId/comments/:commentId/replies', async (request, reply) => {
    const userId = request.user!.userId
    const doc = await prisma.doc.findFirst({ where: { id: request.params.docId, userId } })
    if (!doc) return reply.status(404).send({ error: 'Document not found' })
    // 双重过滤（id + docId）— 防跨文档枚举评论 id，与快照端点同纪律
    const comment = await prisma.docComment.findFirst({ where: { id: request.params.commentId, docId: doc.id } })
    if (!comment) return reply.status(404).send({ error: 'Comment not found' })
    const parsed = createReplySchema.safeParse(request.body)
    if (!parsed.success) {
      // #1064: 信封统一为仓库主流 { error: parsed.error.format() }
      return reply.status(400).send({ error: parsed.error.format() })
    }
    const replyRow = await prisma.docCommentReply.create({
      data: {
        commentId: comment.id,
        role: parsed.data.role,
        text: parsed.data.text,
        createdAt: new Date().toISOString(),
      },
    })
    return reply.status(201).send(serializeReply(replyRow))
  })

  // #1064 集成收口: AI 回复专用入口（web「请AI处理」闭环）— 认证 + 归属
  // 校验同 replies 端点,role 服务端固定 'ai',客户端不可自封其他角色。
  app.post<{ Params: CommentParams; Body: unknown }>('/api/v1/docs/:docId/comments/:commentId/ai-replies', async (request, reply) => {
    const userId = request.user!.userId
    const doc = await prisma.doc.findFirst({ where: { id: request.params.docId, userId } })
    if (!doc) return reply.status(404).send({ error: 'Document not found' })
    const comment = await prisma.docComment.findFirst({ where: { id: request.params.commentId, docId: doc.id } })
    if (!comment) return reply.status(404).send({ error: 'Comment not found' })
    const parsed = aiReplySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.format() })
    }
    const row = await appendCommentReplyInternal({ commentId: comment.id, role: 'ai', text: parsed.data.text })
    return reply.status(201).send(row)
  })

  // ── 切换 status（resolved ↔ reopen；resolvedAt 随之写入/置空）──
  app.patch<{ Params: CommentParams; Body: unknown }>('/api/v1/docs/:docId/comments/:commentId', async (request, reply) => {
    const userId = request.user!.userId
    const doc = await prisma.doc.findFirst({ where: { id: request.params.docId, userId } })
    if (!doc) return reply.status(404).send({ error: 'Document not found' })
    const comment = await prisma.docComment.findFirst({ where: { id: request.params.commentId, docId: doc.id } })
    if (!comment) return reply.status(404).send({ error: 'Comment not found' })
    const parsed = patchCommentSchema.safeParse(request.body)
    if (!parsed.success) {
      // #1064: 信封统一为仓库主流 { error: parsed.error.format() }
      return reply.status(400).send({ error: parsed.error.format() })
    }
    const updated = await prisma.docComment.update({
      where: { id: comment.id },
      data: {
        status: parsed.data.status,
        // #1039 用例 4：resolved 写入切换时刻，reopen 置回 null
        resolvedAt: parsed.data.status === 'resolved' ? new Date().toISOString() : null,
      },
      include: { replies: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    })
    log.info(`[comments] status=${parsed.data.status} id=${comment.id} docId=${doc.id}`)
    return serializeComment(updated)
  })
}
