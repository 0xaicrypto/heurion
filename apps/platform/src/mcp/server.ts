import { realpathSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, relative, isAbsolute } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { canAccess, verifyToken, type Permission, type TokenClaims } from '../auth/token.ts'
import type { ClaimService } from '../claims/service.ts'
import { pptxFor } from '../convert/exports.ts'
import { readLayouts } from '../convert/pptx-layouts.ts'
import { pptxTemplate } from '../convert/pptx-template.ts'
import { DeckOp, newDeckContent } from '../ops/deck.ts'
import type { SlideRenderer } from '../render/slides.ts'
import { deckOutline, deckRead, slideRead } from '../views/deck.ts'
import { checkLayout } from '../views/layout.ts'
import type { CrossrefClient } from '../literature/crossref.ts'
import { formatAma, normalizeDoi } from '../literature/format.ts'
import { importReferences, parseReferences } from '../literature/import-refs.ts'
import type { PubMedClient } from '../literature/pubmed.ts'
import { locate, threadMarks } from '../model/anchors.ts'
import type { Documents } from '../model/runtime.ts'
import type { OpService } from '../ops/service.ts'
import { DocOp, OpError } from '../ops/types.ts'
import { citationOrder, diff, outline, read, ReadError, search } from '../views/read.ts'
import type { KbService } from '../kb/service.ts'
import { MemoryError, type MemoryService } from '../memory/service.ts'
import { DiagramError, renderSvg } from '../render/diagram.ts'
import type { TurnRegistry } from './turns.ts'

export interface McpDeps {
  claims: ClaimService
  renderer: SlideRenderer
  docs: Documents
  ops: OpService
  turns: TurnRegistry
  pubmed: PubMedClient
  crossref: CrossrefClient
  secret: string
  /** 用户工作区目录（asset_upload 只能读这里面的文件）。 */
  workspaceDir: (userId: string) => string
  /** 令牌所属的 dsh 进程是否仍在用（被停止的进程不能再读写）。 */
  isLiveSession: (userId: string, generation: string) => boolean
  /** 参考资料库（可选）。 */
  kb?: KbService
  /** 记忆（可选）。 */
  memory?: MemoryService
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })
const json = (value: unknown) => text(JSON.stringify(value, null, 2))
const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
  isError: true as const,
  content: [{ type: 'text' as const, text: JSON.stringify({ code, message, ...extra }, null, 2) }],
})

const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' }
const MAX_ASSET = 10 * 1024 * 1024

const INSTRUCTIONS = `heurion 文档平台。文档只能通过这些工具读写，不要用 python 或 shell 改文档文件。
工作流程：doc_outline 看结构 → doc_read 读相关章节（拿到块 id 与 rev）→ doc_edit 一次提交一批操作（base_rev 用读到的 rev）。
- 小改动优先 replace_text：find 写块内原文（不能跨块），只改变化的字，格式、引用、评论锚点保留；失配时按返回的 near / matches 修正后重试。整段重写用 replace_block；新增用 insert_after / insert_before。
- 内容格式是 markdown：标题 #、列表 -、表格 GFM、粗体 **、上标 <sup>、图片 ![说明](asset:<asset_id>)。
- 引用：pubmed_search 找文献 → insert_citation 登记 → 正文写返回的 [@c:<cite_id>]。正文中不能出现 DOI、PMID 或手写参考文献，参考文献表由平台自动生成。
- 评论是用户锚定在具体文字上的修改要求：comments_list 读取 → 修改 → comment_reply 说明改了什么。
- 回复用户时用平常的话说明改了什么、改在哪（如「第 2 节第一段」），不要提块 id、rev、cite_id、工具名等内部信息。
- 报错时按返回的 code 与 hint 处理（例如 conflict_user_edited 要基于 current 重新决定改法），不要原样重试。
- 插图：幻灯片里的柱状 / 条形 / 折线 / 饼图优先用 deck_edit 的 add_chart（原生图表，用户能在 PowerPoint 里改数据）；其他数据图（生存曲线、森林图）用 shell 里的 matplotlib 画成图片后 asset_upload；示意图（机制、流程、研究设计）用 diagram_render 写 SVG。拿到 asset_id 后，文档用 ![图注](asset:<asset_id>) 插入，幻灯片用 deck_edit 的 add_image。
- 参考资料库：写作需要依据时用 kb_search 检索用户上传的资料（论文、指南、内部材料），kb_read 读原文；资料是文献时仍用 insert_citation 规范引用。
- 记忆：回合开头的［记忆］是用户确认过的偏好与事实，照做。用户明确说「记住…」「以后都…」时用 memory_propose（explicit=true）记下；用户说「忘掉…」「别再…」时用 memory_forget；发现用户反复强调同一偏好时可以 memory_propose 提议，由用户确认。一条只记一件事，写成以后可直接照做的规则。不要记患者信息、病例细节、账号，也不要记只对本份文档有用的内容。
- 写完带引用的论断后，可用 verify_claims 对照文献摘要自查，并用 claim_report 提交结果。
- 幻灯片（kind=deck）：doc_outline 看各页 → slide_read 读一页（形状 id、位置、文字）→ deck_edit 修改（新页用 add_slide 按版式填内容，不必算坐标）→ layout_check 检查溢出与重叠，必要时 slide_render 看图。`

/** 一次 MCP 请求的上下文。 */
class Ctx {
  constructor(readonly deps: McpDeps, readonly claims: TokenClaims) {}

  get turnId(): string | null {
    return this.deps.turns.active(this.claims.u)?.turnId ?? null
  }

  /** 文档存在、属于该用户、令牌有权限。 */
  check(docId: string, perm: Permission): ReturnType<typeof fail> | null {
    const row = this.deps.docs.store.getDoc(docId)
    if (!row || row.owner !== this.claims.u || row.deleted_at) return fail('doc_not_found', `文档 ${docId} 不存在`, { hint: '用 doc_list 查看可访问的文档（回收站里的文档不可访问）。' })
    if (!canAccess(this.claims, docId, perm)) return fail('forbidden', `没有${perm === 'write' ? '写' : '读'}文档 ${docId} 的权限`)
    return null
  }
}

export function buildMcpServer(deps: McpDeps, claims: TokenClaims): McpServer {
  const ctx = new Ctx(deps, claims)
  const { docs } = deps
  const store = docs.store
  const server = new McpServer({ name: 'heurion', version: '0.1.0' }, { instructions: INSTRUCTIONS })

  server.registerTool('doc_list', {
    description: '列出可访问的文档（id、标题、类型、rev、更新时间）。',
    inputSchema: {},
  }, async () => {
    const projects = new Map(store.listProjects(claims.u).map(p => [p.id, p.name]))
    return json(store.listDocs(claims.u)
      .filter(d => canAccess(claims, d.id, 'read'))
      .map(d => ({ doc_id: d.id, title: d.title, kind: d.kind, project: d.project_id ? projects.get(d.project_id) ?? null : null, rev: d.rev, updated_at: d.updated_at })))
  })

  server.registerTool('docs_search', {
    description: '在用户的全部文档（标题与正文）里搜索，返回命中的文档与上下文片段（命中词用 [ ] 括起）。查找用户以前写过的内容、复用段落时用；在一份文档内部查找用 doc_search。',
    inputSchema: { query: z.string().min(1).describe('要找的词或短语（中文 1 个字以上即可）'), limit: z.number().int().min(1).max(30).optional() },
  }, async ({ query, limit }) => json(store.searchDocs(claims.u, query, limit ?? 10)
    .filter(h => canAccess(claims, h.doc_id, 'read'))
    .map(h => ({ doc_id: h.doc_id, title: h.title, kind: h.kind, snippet: h.snippet, updated_at: h.updated_at }))))

  server.registerTool('doc_create', {
    description: '新建文档：kind=doc（Word 文档，可附初始 markdown，同样受引用规范约束）或 kind=deck（幻灯片，带一页标题页，之后用 deck_edit 添加内容）。返回 doc_id 与 rev。',
    inputSchema: {
      title: z.string().min(1).max(200),
      kind: z.enum(['doc', 'deck']).default('doc'),
      markdown: z.string().optional().describe('doc 的初始内容'),
    },
  }, async ({ title, kind, markdown }) => {
    if (!claims.p.includes('write') || claims.d !== '*') return fail('forbidden', '当前令牌不能新建文档')
    if (kind === 'deck') {
      const pkg = pptxTemplate()
      const row = docs.create({ owner: claims.u, title, kind: 'deck', content: newDeckContent(readLayouts(pkg).layouts, title) })
      store.putPackage(row.id, 'pptx', pkg)
      deps.turns.touch(claims.u, row.id)
      return json({ doc_id: row.id, kind: 'deck', title, rev: 0, layouts: readLayouts(pkg).layouts.map(l => l.name) })
    }
    const row = docs.create({ owner: claims.u, title })
    if (markdown?.trim()) {
      const first = docs.get(row.id).child(0).attrs.id as string
      try {
        deps.ops.edit({ doc_id: row.id, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id: first, markdown }] }, { actor: 'ai', turnId: ctx.turnId })
      } catch (err) {
        docs.store.deleteDoc(row.id)
        docs.unload(row.id)
        if (err instanceof OpError) return fail(err.code, err.message, err.extra)
        throw err
      }
    }
    deps.turns.touch(claims.u, row.id)
    return json({ doc_id: row.id, title, rev: docs.rev(row.id) })
  })

  server.registerTool('doc_outline', {
    description: '文档结构：标题树（含块 id、各节块数与字数）、rev、引用与评论数。编辑前先看这个。',
    inputSchema: { doc_id: z.string() },
  }, async ({ doc_id }) => {
    const denied = ctx.check(doc_id, 'read')
    if (denied) return denied
    const row = store.getDoc(doc_id)!
    if (row.kind === 'deck') {
      const info = deps.ops.deckContextInfo(doc_id)
      return text(deckOutline({ doc: docs.get(doc_id), docId: doc_id, title: row.title, rev: docs.rev(doc_id), layouts: info.layouts, size: info.size, openComments: store.listComments(doc_id, 'open').length }))
    }
    return text(outline({
      doc: docs.get(doc_id), docId: doc_id, title: row.title, rev: docs.rev(doc_id),
      citations: store.listCitations(doc_id), openComments: store.listComments(doc_id, 'open').length,
    }))
  })

  server.registerTool('doc_read', {
    description:
      '读文档内容：每个块带 {#id} 前缀的 markdown，开头一行给出 rev。可按章节（section_id = 标题 id）、' +
      '块范围（from_id / to_id）读取；内容较长时分页，按返回的 cursor 继续。末尾列出范围内的 open 评论。',
    inputSchema: {
      doc_id: z.string(),
      section_id: z.string().optional(),
      from_id: z.string().optional(),
      to_id: z.string().optional(),
      cursor: z.number().int().min(0).optional(),
    },
  }, async args => {
    const denied = ctx.check(args.doc_id, 'read')
    if (denied) return denied
    if (store.getDoc(args.doc_id)!.kind === 'deck') return text(deckRead(docs.get(args.doc_id), docs.rev(args.doc_id), args.cursor ?? 0))
    try {
      return text(read({ ...args, doc: docs.get(args.doc_id), docId: args.doc_id, rev: docs.rev(args.doc_id), comments: store.listComments(args.doc_id, 'open') }))
    } catch (err) {
      if (err instanceof ReadError) return fail('node_not_found', err.message)
      throw err
    }
  })

  server.registerTool('doc_search', {
    description: '在文档中检索文字，返回命中块的 id 与片段。',
    inputSchema: { doc_id: z.string(), query: z.string().min(1) },
  }, async ({ doc_id, query }) => {
    const denied = ctx.check(doc_id, 'read')
    if (denied) return denied
    return json({ rev: docs.rev(doc_id), hits: search(docs.get(doc_id), query) })
  })

  server.registerTool('doc_edit', {
    description:
      '按块 id 编辑文档：一批操作原子提交（任一失败则全部不生效）。base_rev 用最近一次读到的 rev。' +
      '操作：insert_after / insert_before {anchor_id, markdown}；replace_block {id, markdown}；' +
      'replace_text {id, find, replace, occurrence?}（块内替换，小改动首选：find 即守卫，不受 base_rev 限制；只改变化的字）；delete {ids}；' +
      'move {ids, after}；set_block_style {id, type?, level?, align?, style?}；' +
      'table_set_cells {id, cells:[{row, col, markdown}]}；table_insert_rows {id, at, rows}；table_delete_rows {id, at, count}。' +
      '会移除 open 评论锚点时，需把线程 id 放进 ack_comments 并在线程里说明。',
    inputSchema: {
      doc_id: z.string(),
      base_rev: z.number().int().min(0),
      mode: z.enum(['apply', 'suggest']).optional(),
      ack_comments: z.array(z.string()).optional(),
      ops: z.array(DocOp).min(1).max(50),
    },
  }, async args => {
    const denied = ctx.check(args.doc_id, 'write')
    if (denied) return denied
    if (store.getDoc(args.doc_id)!.kind === 'deck') return fail('wrong_tool', '这是幻灯片文档，请用 deck_edit')
    try {
      const forced = deps.turns.active(claims.u)?.mode
      const mode = forced === 'suggest' ? 'suggest' : args.mode ?? 'apply'
      const result = deps.ops.edit({ ...args, mode }, { actor: 'ai', turnId: ctx.turnId, answering: deps.turns.active(claims.u)?.answering ?? null })
      deps.turns.touch(claims.u, args.doc_id)
      return json({
        rev: result.rev,
        results: result.results,
        changed: result.changes.length,
        mode,
        note: result.changes.length === 0 ? '操作没有改变文档内容' : mode === 'suggest' ? '已作为待采纳修订提交，用户采纳后生效' : undefined,
      })
    } catch (err) {
      if (err instanceof OpError) return fail(err.code, err.message, err.extra)
      throw err
    }
  })

  server.registerTool('doc_history', {
    description: '版本列表（seq、rev、来源、回合、说明）。',
    inputSchema: { doc_id: z.string() },
  }, async ({ doc_id }) => {
    const denied = ctx.check(doc_id, 'read')
    if (denied) return denied
    return json({ rev: docs.rev(doc_id), versions: store.listVersions(doc_id).slice(0, 30) })
  })

  server.registerTool('doc_diff', {
    description: '两个版本之间的块级变化（新增 / 删除 / 修改，附前后文字）。版本号是 doc_history 的 seq（不是 rev）；也可以给 from_rev，取该 rev 时或之前最近的版本。to_version 缺省为当前内容。',
    inputSchema: {
      doc_id: z.string(),
      from_version: z.number().int().min(1).optional(),
      from_rev: z.number().int().min(0).optional(),
      to_version: z.number().int().min(1).optional(),
    },
  }, async ({ doc_id, from_version, from_rev, to_version }) => {
    const denied = ctx.check(doc_id, 'read')
    if (denied) return denied
    const versions = store.listVersions(doc_id)
    const seq = from_version ?? (from_rev !== undefined ? versions.find(v => v.rev <= from_rev)?.seq : undefined)
    const before = seq ? docs.versionDoc(doc_id, seq) : null
    const after = to_version ? docs.versionDoc(doc_id, to_version) : docs.get(doc_id)
    if (!before || !after) {
      return fail('version_not_found', '版本不存在', {
        hint: '版本号是下面 available 里的 seq（不是 rev）。',
        available: versions.slice(0, 10).map(v => ({ seq: v.seq, rev: v.rev, source: v.source, note: v.note })),
      })
    }
    return json({ from_version: seq, changes: diff(before, after) })
  })

  // —— 幻灯片（deck） ——

  const deckOnly = (docId: string) => store.getDoc(docId)?.kind === 'deck' ? null : fail('wrong_tool', '这不是幻灯片文档，请用 doc_* 工具')

  server.registerTool('slide_read', {
    description: '读一页幻灯片：每个形状的 id、种类、占位符、位置与大小（pt）、文字（markdown，列表项按级别缩进）和备注。编辑前先读。',
    inputSchema: { doc_id: z.string(), slide_id: z.string() },
  }, async ({ doc_id, slide_id }) => {
    const denied = ctx.check(doc_id, 'read') ?? deckOnly(doc_id)
    if (denied) return denied
    const doc = docs.get(doc_id)
    let found: { node: Parameters<typeof slideRead>[0]; index: number } | null = null
    doc.forEach((s, _o, i) => { if (s.attrs.id === slide_id) found = { node: s, index: i } })
    if (!found) return fail('node_not_found', `找不到幻灯片 ${slide_id}`, { hint: '用 doc_outline 查看各页 id。' })
    const f = found as { node: Parameters<typeof slideRead>[0]; index: number }
    return text(slideRead(f.node, f.index, docs.rev(doc_id)))
  })

  server.registerTool('deck_edit', {
    description:
      '编辑幻灯片：一批操作原子提交，base_rev 用最近读到的 rev。几何单位 pt。操作：' +
      'add_slide {after, layout?, title?, body?}（按版式填占位符，不需要算坐标）；delete_slide {slide_id}；move_slide {slide_id, after}；' +
      'set_text {shape_id, markdown}（整体重写，按模板格式；列表项 - 对应项目符号）；replace_text {shape_id, find, replace}（小改动首选）；' +
      'set_paragraphs {shape_id, paragraphs:[{text, lvl?}]}（逐段改写多段文字，未改的字保留原有颜色、加粗、引用与评论标记）；' +
      'add_shape {slide_id, markdown?, x, y, w, h, font_size?, geometry?: rect|roundRect|ellipse, fill?, color?}（文本框；带 geometry / fill 即色块、标题条、卡片）；' +
      'set_xfrm {shape_id, x?, y?, w?, h?}；delete_shape {shape_id}；set_z {shape_id, to: front|back|forward|backward}；' +
      'set_fill {shape_id, color}；set_background {slide_id, color}；set_text_style {shape_id, paragraph?, color?, size?, bold?, italic?, align?}；' +
      'add_image {slide_id, asset_id, x, y, w, h?}（图片先用 asset_upload 上传；h 缺省按原图比例）；' +
      'add_table {slide_id, x, y, w, rows:[[...]], header?, font_size?}（表头用主题强调色；之后用 table_set_cells 改单元格）；' +
      'table_insert_rows {shape_id, at, rows?} / table_delete_rows {shape_id, at, count?} / table_insert_cols {shape_id, at, cells?} / table_delete_cols {shape_id, at, count?}（新行列沿用相邻格式）；' +
      'chart_set_data {shape_id, categories?, series:[{name, values}], title?}（改图表数据，slide_read 里能读到原数据；导出同时更新内嵌工作簿）；' +
      'add_chart {slide_id, type: column|bar|line|pie|area|doughnut, x, y, w, h, title?, categories, series}（原生图表，颜色取主题）；' +
      'chart_set_type {shape_id, type}（换图表类型，数据不变；饼图 / 圆环图只能一个系列；导入的图表换类型后形状 id 会变，以返回的为准）；' +
      'align_shapes {shape_ids, align: left|center|right|top|middle|bottom, to?: selection|slide}；distribute_shapes {shape_ids（≥3）, direction: horizontal|vertical}（对齐与等距，不必自己算坐标）；' +
      'apply_theme {theme, slide_ids?}（整套配色：背景、标题与正文颜色、强调色；之后新加的页沿用）；' +
      'set_notes {slide_id, markdown}；table_set_cells {shape_id, cells:[{row, col, markdown}]}。' +
      '颜色写 6 位十六进制或主题记号（accent / accent2 / title / body / muted / bg / surface，按该页主题取色）。改完用 layout_check 检查溢出与重叠，必要时 slide_render 看效果。',
    inputSchema: {
      doc_id: z.string(),
      base_rev: z.number().int().min(0),
      mode: z.enum(['apply', 'suggest']).optional(),
      ack_comments: z.array(z.string()).optional(),
      ops: z.array(DeckOp).min(1).max(50),
    },
  }, async args => {
    const denied = ctx.check(args.doc_id, 'write') ?? deckOnly(args.doc_id)
    if (denied) return denied
    try {
      const forced = deps.turns.active(claims.u)?.mode
      const mode = forced === 'suggest' ? 'suggest' : args.mode ?? 'apply'
      const result = deps.ops.edit({ ...args, mode }, { actor: 'ai', turnId: ctx.turnId, answering: deps.turns.active(claims.u)?.answering ?? null })
      deps.turns.touch(claims.u, args.doc_id)
      return json({ rev: result.rev, results: result.results, changed: result.changes.length, mode })
    } catch (err) {
      if (err instanceof OpError) return fail(err.code, err.message, err.extra)
      throw err
    }
  })

  server.registerTool('layout_check', {
    description: '版面检查（近似）：文字溢出形状、形状重叠、超出页面、字号过小。返回问题列表（附形状 id）；为空表示没发现问题。',
    inputSchema: { doc_id: z.string(), slide_ids: z.array(z.string()).optional() },
  }, async ({ doc_id, slide_ids }) => {
    const denied = ctx.check(doc_id, 'read') ?? deckOnly(doc_id)
    if (denied) return denied
    const issues = checkLayout(docs.get(doc_id), deps.ops.deckContextInfo(doc_id).size, slide_ids)
    return json({ rev: docs.rev(doc_id), issues })
  })

  server.registerTool('slide_render', {
    description: '把一页幻灯片渲染成图片（LibreOffice），用来目视检查排版。较慢（数秒），只在需要时用。',
    inputSchema: { doc_id: z.string(), slide_id: z.string() },
  }, async ({ doc_id, slide_id }) => {
    const denied = ctx.check(doc_id, 'read') ?? deckOnly(doc_id)
    if (denied) return denied
    const doc = docs.get(doc_id)
    let index = -1
    doc.forEach((s, _o, i) => { if (s.attrs.id === slide_id) index = i })
    if (index < 0) return fail('node_not_found', `找不到幻灯片 ${slide_id}`)
    try {
      const pngs = await deps.renderer.render(`${doc_id}/${docs.rev(doc_id)}`, () => pptxFor(docs, doc_id).bytes)
      const png = pngs[index]
      if (!png) return fail('render_failed', '渲染结果缺少这一页')
      return { content: [{ type: 'image' as const, data: readFileSync(png).toString('base64'), mimeType: 'image/png' }] }
    } catch (err) {
      return fail('render_unavailable', (err as Error).message, { hint: '改用 layout_check 检查版面。' })
    }
  })

  // —— 评论 ——

  server.registerTool('comments_list', {
    description: '评论线程（用户锚定在具体文字上的修改要求）：锚点所在块 id、被锚定的文字、用户要求与回复。',
    inputSchema: {
      doc_id: z.string(),
      status: z.enum(['open', 'resolved']).optional(),
      comment_id: z.string().optional(),
    },
  }, async ({ doc_id, status, comment_id }) => {
    const denied = ctx.check(doc_id, 'read')
    if (denied) return denied
    const doc = docs.get(doc_id)
    const marks = threadMarks(doc)
    const list = comment_id
      ? [store.getComment(doc_id, comment_id)].filter(c => c !== undefined)
      : store.listComments(doc_id, status ?? 'open')
    return json({
      rev: docs.rev(doc_id),
      comments: list.map(c => {
        const loc = locate(doc, c, marks)
        return {
          comment_id: c.id, status: c.status,
          anchor: { located: loc.located, node_ids: loc.node_ids, text: loc.text || c.snippet },
          thread: c.replies.map(r => ({ role: r.role, text: r.text })),
        }
      }),
    })
  })

  server.registerTool('comment_reply', {
    description: '在评论线程里回复（身份固定为 AI）：说明改了什么、改在哪，或为什么没改。',
    inputSchema: { doc_id: z.string(), comment_id: z.string(), text: z.string().min(1).max(10_000) },
  }, async ({ doc_id, comment_id, text: body }) => {
    const denied = ctx.check(doc_id, 'write')
    if (denied) return denied
    if (!store.getComment(doc_id, comment_id)) return fail('comment_not_found', `评论 ${comment_id} 不存在`)
    const reply = store.addReply(comment_id, 'ai', body, ctx.turnId)
    deps.turns.notify(claims.u, { type: 'comment_reply', doc_id, comment_id })
    return json({ comment_id, reply_id: reply.id })
  })

  server.registerTool('comment_resolve', {
    description: '关闭评论线程：仅用于判断无需修改、并已用 comment_reply 说明原因的情况。做了修改的线程留给用户确认后关闭。',
    inputSchema: { doc_id: z.string(), comment_id: z.string() },
  }, async ({ doc_id, comment_id }) => {
    const denied = ctx.check(doc_id, 'write')
    if (denied) return denied
    const c = store.getComment(doc_id, comment_id)
    if (!c) return fail('comment_not_found', `评论 ${comment_id} 不存在`)
    if (c.status === 'resolved') return fail('already_resolved', '线程已关闭')
    if (c.replies.at(-1)?.role !== 'ai') return fail('reply_required', '关闭前先用 comment_reply 说明处理结果')
    if (deps.turns.active(claims.u)?.touched.has(doc_id)) {
      return fail('user_confirms_changes', '本回合已修改文档：线程保持 open，由用户确认后关闭', { hint: '只有判断无需修改时才由你关闭线程。' })
    }
    store.setCommentStatus(doc_id, comment_id, 'resolved', 'ai')
    deps.turns.notify(claims.u, { type: 'comment_reply', doc_id, comment_id })
    return json({ comment_id, status: 'resolved' })
  })

  // —— 文献与引用 ——

  server.registerTool('pubmed_search', {
    description: '检索 PubMed，返回 PMID、DOI、标题、作者、期刊、年份。',
    inputSchema: { query: z.string().min(1).describe('PubMed 检索式，可用 MeSH 与布尔运算'), limit: z.number().int().min(1).max(20).default(10) },
  }, async ({ query, limit }) => json(await deps.pubmed.search(query, limit)))

  server.registerTool('doi_lookup', {
    description: '按 DOI 查 Crossref 元数据，核实文献是否存在。',
    inputSchema: { doi: z.string().min(1) },
  }, async ({ doi }) => json(await deps.crossref.lookup(doi) ?? { found: false, doi: normalizeDoi(doi) }))

  server.registerTool('insert_citation', {
    description: '为文档登记一条引用（DOI 必须能在 Crossref 查到），返回 cite_id。正文里写 [@c:<cite_id>] 引用它；编号与参考文献表由平台生成。',
    inputSchema: { doc_id: z.string(), doi: z.string().min(1), pmid: z.string().optional() },
  }, async ({ doc_id, doi, pmid }) => {
    const denied = ctx.check(doc_id, 'write')
    if (denied) return denied
    const article = await deps.crossref.lookup(doi)
    if (!article) return fail('doi_not_found', `DOI ${normalizeDoi(doi)} 在 Crossref 查不到，不能作为引用`, { hint: '用 pubmed_search 找到真实文献的 DOI。' })
    const row = store.upsertCitation({ doc_id, doi: article.doi!, pmid: pmid ?? null, formatted: formatAma(article), url: `https://doi.org/${article.doi}` })
    return json({ cite_id: row.id, marker: `[@c:${row.id}]`, formatted: row.formatted })
  })

  server.registerTool('import_references', {
    description:
      '把一份文献列表批量登记到文档的引用登记表（RIS / BibTeX / PubMed MEDLINE / EndNote XML，或每行一个 DOI / PMID）。' +
      '每条按 DOI 经 Crossref 核实（只有 PMID 的经 PubMed 补 DOI），查不到的跳过并报告。登记后用 list_citations 拿 cite_id 引用。' +
      '用户给了参考文献列表（粘贴或在工作区里的文件内容）时用；与网页「导入参考文献」同一个操作。',
    inputSchema: { doc_id: z.string(), text: z.string().min(1).max(5_000_000).describe('文献列表原文') },
  }, async ({ doc_id, text }) => {
    const denied = ctx.check(doc_id, 'write')
    if (denied) return denied
    const refs = parseReferences(text)
    if (refs.length === 0) return fail('no_references', '没有识别出文献', { hint: '支持 RIS、BibTeX、PubMed MEDLINE、EndNote XML，或每行一个 DOI / PMID。' })
    const r = await importReferences({ store, crossref: deps.crossref, pubmed: deps.pubmed }, doc_id, refs)
    return json({ added: r.added.length, already: r.already, skipped: r.skipped, sample: r.added.slice(0, 5) })
  })

  server.registerTool('list_citations', {
    description: '本文档已登记的引用：cite_id、文中编号（未使用则为 null）、条目。',
    inputSchema: { doc_id: z.string() },
  }, async ({ doc_id }) => {
    const denied = ctx.check(doc_id, 'read')
    if (denied) return denied
    const order = citationOrder(docs.get(doc_id))
    return json(store.listCitations(doc_id).map(c => ({
      cite_id: c.id, number: order.includes(c.id) ? order.indexOf(c.id) + 1 : null, doi: c.doi, formatted: c.formatted,
    })))
  })

  // —— 论断核对（M1） ——

  server.registerTool('verify_claims', {
    description:
      '论断核对：返回一页带引用的句子及所引文献的 PubMed 摘要，以及含数值却没有引用的句子（unsourced，仅第一页）。' +
      '逐条判断后用 claim_report 提交；按 next_cursor 翻页。只核对，不修改正文。',
    inputSchema: { doc_id: z.string(), cursor: z.number().int().min(0).optional() },
  }, async ({ doc_id, cursor }) => {
    const denied = ctx.check(doc_id, 'read')
    if (denied) return denied
    return json(await deps.claims.evidence(doc_id, cursor ?? 0))
  })

  server.registerTool('claim_report', {
    description:
      '提交论断核对结果。verdict：supported / unsupported / unclear / missing_citation（unsourced 的数值句）。' +
      '不支持、缺出处、有证据但不足以判断的 unclear，平台会在该句挂一条 AI 评论供用户决定是否修改；' +
      '没有可核对证据的 unclear（无摘要或摘要没涉及）标 no_evidence=true，只记录不挂评论，在总结里汇总。reason 用中文写明依据。',
    inputSchema: {
      doc_id: z.string(),
      results: z.array(z.object({
        claim_id: z.string(),
        verdict: z.enum(['supported', 'unsupported', 'unclear', 'missing_citation']),
        reason: z.string().min(1).max(1000),
        no_evidence: z.boolean().optional().describe('unclear 时：所引文献没有摘要，或摘要根本没涉及该句的内容'),
      })).min(1).max(50),
    },
  }, async ({ doc_id, results }) => {
    const denied = ctx.check(doc_id, 'write')
    if (denied) return denied
    const out = deps.claims.report(doc_id, results)
    if (out.some(r => r.status === 'commented')) deps.turns.notify(claims.u, { type: 'comment_reply', doc_id, comment_id: '' })
    return json({ results: out, note: out.some(r => r.status === 'stale') ? 'stale：该句已被修改或不存在，请重新 verify_claims' : undefined })
  })

  // —— 资产 ——

  server.registerTool('asset_upload', {
    description: '把工作区里的图片（png/jpg/svg/gif/webp，≤10MB）上传为平台资产，返回 asset_id；之后用 ![说明](asset:<asset_id>) 插入文档。',
    inputSchema: { path: z.string().min(1).describe('工作区内的相对路径') },
  }, async ({ path }) => {
    if (!claims.p.includes('write')) return fail('forbidden', '当前令牌不能上传资产')
    const root = realpathSync(deps.workspaceDir(claims.u))
    let file: string
    try {
      file = realpathSync(isAbsolute(path) ? path : join(root, path))
    } catch {
      return fail('file_not_found', `找不到文件 ${path}`, { hint: '路径相对于工作目录。' })
    }
    const rel = relative(root, file)
    if (rel.startsWith('..') || isAbsolute(rel)) return fail('forbidden', '只能上传工作目录内的文件')
    const mime = IMAGE_MIME[extname(file).toLowerCase()]
    if (!mime) return fail('unsupported_type', `不支持的文件类型 ${extname(file)}`, { hint: '支持 png/jpg/svg/gif/webp。' })
    if (statSync(file).size > MAX_ASSET) return fail('too_large', '文件超过 10MB')
    const asset = store.putAsset({ owner: claims.u, mime, name: rel, bytes: readFileSync(file) })
    return json({ asset_id: asset.id, mime, size: asset.size, markdown: `![说明](asset:${asset.id})` })
  })

  server.registerTool('kb_search', {
    description:
      '在用户的参考资料库（上传的论文、指南、内部材料）里检索，返回相关片段与出处（文件名、页码；资料若是已发表文献带 DOI / PMID）。' +
      '写作需要依据时先检索资料库；资料是已发表文献时，引用仍须 insert_citation 登记（用 DOI / PMID），非文献资料在回复里标明出处（文件名与页码），不进参考文献表。',
    inputSchema: {
      query: z.string().min(1).describe('要找的内容（自然语言或关键词）'),
      file_ids: z.array(z.string()).optional().describe('只在这些资料里找（用户在对话里选中的资料会在提示里给出 file_id）'),
      project: z.string().optional().describe('只在这个项目的资料里找（项目 id）'),
      top_k: z.number().int().min(1).max(20).optional(),
    },
  }, async ({ query, file_ids, project, top_k }) => {
    if (!deps.kb) return fail('kb_unavailable', '资料库未启用')
    let ids = file_ids
    if (project) ids = store.listKbFiles(claims.u, project).map(f => f.id).filter(id => !file_ids || file_ids.includes(id))
    const hits = await deps.kb.search(claims.u, query, { limit: top_k ?? 8, fileIds: ids })
    return json(hits.map(h => ({ file_id: h.file_id, file: h.file_name, page: h.page, doi: h.doi, pmid: h.pmid, text: h.text })))
  })

  server.registerTool('memory_propose', {
    description:
      '记住用户的写作偏好、常用写法 / 术语、反复用到的事实（如「数值保留两位小数」「本院伦理批号 …」）。' +
      '用户明确要求记住时 explicit=true，直接生效；否则作为提议，等用户在对话里确认。不能记患者可识别信息、病例细节、账号。',
    inputSchema: {
      content: z.string().min(1).max(500).describe('一条记忆，写成以后可直接照做的规则或事实'),
      kind: z.enum(['preference', 'fact', 'style', 'term']).describe('preference 偏好 / fact 事实 / style 写法 / term 术语'),
      scope: z.enum(['global', 'project']).optional().describe('global 所有文档（默认）/ project 只用于当前文档所在项目'),
      reason: z.string().max(200).optional().describe('为什么值得记（给用户看）'),
      explicit: z.boolean().optional().describe('用户在本轮明确要求记住'),
    },
  }, async ({ content, kind, scope, reason, explicit }) => {
    if (!deps.memory) return fail('memory_unavailable', '记忆未启用')
    const turn = deps.turns.active(claims.u)
    if (turn && turn.memory === false) return fail('memory_off', '本轮不使用记忆（用户关闭或已暂停）', { hint: '不要提议记忆，正常完成任务即可。' })
    try {
      const r = await deps.memory.propose(claims.u, { content, kind, scope: scope ?? 'global', reason, explicit }, { docId: turn?.docId ?? null, turnId: turn?.turnId ?? null, source: 'turn', actor: 'ai' })
      if (r.result === 'proposed' || r.result === 'active') deps.turns.notify(claims.u, { type: 'memory', result: r.result, memory: r.memory })
      const said = { proposed: '已提议，等用户确认', active: '已记住（用户明确要求，直接生效）', merged: '已有相同的记忆，未重复添加', previously_rejected: '用户之前拒绝过这条，不再提议' }[r.result]
      return json({ result: r.result, message: said })
    } catch (err) {
      if (err instanceof MemoryError) return fail(err.code, err.message, err.hint ? { hint: err.hint } : {})
      throw err
    }
  })

  server.registerTool('memory_forget', {
    description:
      '忘掉记忆：只在用户明确要求「忘掉 / 别再… / 删掉那条记忆」时调用。target 写用户要忘的内容；唯一命中就彻底删除，' +
      '命中多条时返回候选（ambiguous），先问用户指的是哪几条，再用 memory_ids 指定。暂停记忆或本轮不用记忆时也可以用。',
    inputSchema: {
      target: z.string().min(1).describe('用户要忘掉的内容（用户的原话或概括）'),
      memory_ids: z.array(z.string()).optional().describe('从 ambiguous 候选里确认后的 id'),
    },
  }, async ({ target, memory_ids }) => {
    if (!deps.memory) return fail('memory_unavailable', '记忆未启用')
    try {
      const r = await deps.memory.forget(claims.u, target, memory_ids)
      if (r.result === 'not_found') return fail('not_found', '没有找到相关的记忆', { hint: '告诉用户没有这样的记忆；可以请用户在「记忆」页里查看。' })
      if (r.result === 'ambiguous') {
        return json({ result: 'ambiguous', message: '有多条相近的记忆，先跟用户确认要忘哪几条（复述内容，不要提 id）', candidates: r.candidates.map(m => ({ id: m.id, content: m.content, status: m.status })) })
      }
      for (const m of r.memories) deps.turns.notify(claims.u, { type: 'memory', result: 'forgotten', memory: m })
      return json({ result: 'forgotten', forgotten: r.memories.map(m => m.content), message: '已彻底删除，之后的对话不再使用' })
    } catch (err) {
      if (err instanceof MemoryError) return fail(err.code, err.message, err.hint ? { hint: err.hint } : {})
      throw err
    }
  })

  server.registerTool('memory_search', {
    description: '按需检索用户已确认的记忆（回合开头注入的［记忆］之外，想确认有没有相关偏好或事实时用）。',
    inputSchema: { query: z.string().min(1) },
  }, async ({ query }) => {
    if (!deps.memory) return fail('memory_unavailable', '记忆未启用')
    const turn = deps.turns.active(claims.u)
    if ((turn && turn.memory === false) || !deps.memory.active(claims.u)) return fail('memory_off', '本轮不使用记忆', { hint: '不要依赖记忆，按本轮要求完成。' })
    const hits = await deps.memory.search(claims.u, query, turn?.docId ?? null)
    return json(hits.map(m => ({ kind: m.kind, scope: m.scope, content: m.content })))
  })

  server.registerTool('kb_read', {
    description: '读参考资料库里一份资料的原文（按页；kb_search 命中后要看上下文时用）。',
    inputSchema: {
      file_id: z.string(),
      from_page: z.number().int().min(1).optional(),
      to_page: z.number().int().min(1).optional().describe('缺省读到 from_page 后 2 页'),
    },
  }, async ({ file_id, from_page, to_page }) => {
    const f = store.getKbFile(file_id)
    if (!f || f.owner !== claims.u) return fail('file_not_found', `资料 ${file_id} 不存在`, { hint: '用 kb_search 找到资料再读。' })
    const from = from_page ?? 1
    const pages = store.kbText(f.id, from, to_page ?? from + 2)
    const text = pages.map(p => `［第 ${p.page} 页］${p.text}`).join('\n\n').slice(0, 20000)
    return { content: [{ type: 'text' as const, text: `《${f.name}》${f.doi ? ` DOI ${f.doi}` : ''}${f.pmid ? ` PMID ${f.pmid}` : ''} · 共 ${f.pages} 页\n\n${text || '（这几页没有文字）'}` }] }
  })

  server.registerTool('diagram_render', {
    description:
      '生成示意图：写一段自包含的 SVG（机制图、流程图、研究设计图、对比图等），平台渲染成 PNG 存为资产，返回 asset_id。' +
      '之后插入：文档用 doc_edit 写 ![图注](asset:<asset_id>)；幻灯片用 deck_edit 的 add_image。' +
      '要求：带 viewBox 与 width/height；文字用 <text>（中文字体用 Noto Sans CJK SC）；不能有脚本、事件属性、foreignObject、外部链接或外部图片。' +
      '数据图（生存曲线、森林图等）用 shell 里的 matplotlib 画再 asset_upload 更准确。',
    inputSchema: {
      svg: z.string().min(20).describe('完整的 SVG 文本'),
      name: z.string().max(80).optional().describe('文件名 / 说明'),
      width_px: z.number().int().min(200).max(4096).optional().describe('输出宽度像素，缺省 1600'),
    },
  }, async ({ svg, name, width_px }) => {
    if (!claims.p.includes('write')) return fail('forbidden', '当前令牌不能上传资产')
    let out: ReturnType<typeof renderSvg>
    try {
      out = renderSvg(svg, width_px)
    } catch (err) {
      if (err instanceof DiagramError) return fail('invalid_svg', err.message, { hint: '改正后重新调用；SVG 必须自包含。' })
      throw err
    }
    const label = (name ?? '示意图').trim() || '示意图'
    const asset = store.putAsset({ owner: claims.u, mime: 'image/png', name: `${label}.png`, bytes: out.png })
    return json({ asset_id: asset.id, width: out.width, height: out.height, markdown: `![${label}](asset:${asset.id})` })
  })

  return server
}

/** 无状态 Streamable HTTP：每个请求新建 server + transport。 */
export async function handleMcp(deps: McpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = req.headers.authorization ?? ''
  const claims = auth.startsWith('Bearer ') ? verifyToken(deps.secret, auth.slice(7), 'mcp') : null
  if (!claims) {
    res.writeHead(401).end('unauthorized')
    return
  }
  // 回合被停止 / 超时后，旧 dsh 进程可能还会活几秒：它的调用一律拒绝，免得写入记到下一个回合名下
  if (claims.s && !deps.isLiveSession(claims.u, claims.s)) {
    res.writeHead(401).end('session stopped')
    return
  }
  const server = buildMcpServer(deps, claims)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => { void transport.close(); void server.close() })
  await server.connect(transport)
  await transport.handleRequest(req, res)
}
