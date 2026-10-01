import { realpathSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, relative, isAbsolute } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { canAccess, verifyToken, type Permission, type TokenClaims } from '../auth/token.ts'
import type { ClaimService } from '../claims/service.ts'
import type { CrossrefClient } from '../literature/crossref.ts'
import { formatAma, normalizeDoi } from '../literature/format.ts'
import type { PubMedClient } from '../literature/pubmed.ts'
import { locate, threadMarks } from '../model/anchors.ts'
import type { Documents } from '../model/runtime.ts'
import type { OpService } from '../ops/service.ts'
import { DocOp, OpError } from '../ops/types.ts'
import { citationOrder, diff, outline, read, ReadError, search } from '../views/read.ts'
import type { TurnRegistry } from './turns.ts'

export interface McpDeps {
  claims: ClaimService
  docs: Documents
  ops: OpService
  turns: TurnRegistry
  pubmed: PubMedClient
  crossref: CrossrefClient
  secret: string
  /** 用户工作区目录（asset_upload 只能读这里面的文件）。 */
  workspaceDir: (userId: string) => string
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
- 小改动优先 replace_text（保留原格式）；整段重写用 replace_block；新增用 insert_after / insert_before。
- 内容格式是 markdown：标题 #、列表 -、表格 GFM、粗体 **、上标 <sup>、图片 ![说明](asset:<asset_id>)。
- 引用：pubmed_search 找文献 → insert_citation 登记 → 正文写返回的 [@c:<cite_id>]。正文中不能出现 DOI、PMID 或手写参考文献，参考文献表由平台自动生成。
- 评论是用户锚定在具体文字上的修改要求：comments_list 读取 → 修改 → comment_reply 说明改了什么。
- 报错时按返回的 code 与 hint 处理（例如 conflict_user_edited 要基于 current 重新决定改法），不要原样重试。
- 图表用 shell 生成图片文件后，用 asset_upload 上传，再用 ![说明](asset:<asset_id>) 插入。
- 写完带引用的论断后，可用 verify_claims 对照文献摘要自查，并用 claim_report 提交结果。`

/** 一次 MCP 请求的上下文。 */
class Ctx {
  constructor(readonly deps: McpDeps, readonly claims: TokenClaims) {}

  get turnId(): string | null {
    return this.deps.turns.active(this.claims.u)?.turnId ?? null
  }

  /** 文档存在、属于该用户、令牌有权限。 */
  check(docId: string, perm: Permission): ReturnType<typeof fail> | null {
    const row = this.deps.docs.store.getDoc(docId)
    if (!row || row.owner !== this.claims.u) return fail('doc_not_found', `文档 ${docId} 不存在`, { hint: '用 doc_list 查看可访问的文档。' })
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
  }, async () => json(store.listDocs(claims.u)
    .filter(d => canAccess(claims, d.id, 'read'))
    .map(d => ({ doc_id: d.id, title: d.title, kind: d.kind, rev: d.rev, updated_at: d.updated_at }))))

  server.registerTool('doc_create', {
    description: '新建 doc 文档，可附初始内容（markdown，同样受引用规范约束）。返回 doc_id 与 rev。',
    inputSchema: {
      title: z.string().min(1).max(200),
      markdown: z.string().optional().describe('初始内容'),
    },
  }, async ({ title, markdown }) => {
    if (!claims.p.includes('write') || claims.d !== '*') return fail('forbidden', '当前令牌不能新建文档')
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
      'replace_text {id, find, replace, occurrence?}（块内替换，保留格式，小改动首选）；delete {ids}；' +
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
    try {
      const forced = deps.turns.active(claims.u)?.mode
      const mode = forced === 'suggest' ? 'suggest' : args.mode ?? 'apply'
      const result = deps.ops.edit({ ...args, mode }, { actor: 'ai', turnId: ctx.turnId })
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
      '除 supported 外，平台会在该句挂一条 AI 评论供用户决定是否修改；reason 写明依据。',
    inputSchema: {
      doc_id: z.string(),
      results: z.array(z.object({
        claim_id: z.string(),
        verdict: z.enum(['supported', 'unsupported', 'unclear', 'missing_citation']),
        reason: z.string().min(1).max(1000),
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
  const server = buildMcpServer(deps, claims)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => { void transport.close(); void server.close() })
  await server.connect(transport)
  await transport.handleRequest(req, res)
}
