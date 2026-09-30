import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { Store } from '../db.ts'
import { locateAnchor } from '../docs/comments.ts'
import type { CrossrefClient } from './crossref.ts'
import { formatAma, normalizeDoi } from './format.ts'
import type { PubMedClient } from './pubmed.ts'
import { verifyDocToken } from './token.ts'

export interface LiteratureDeps {
  store: Store
  pubmed: PubMedClient
  crossref: CrossrefClient
  secret: string
}

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] })

/** 工具失败统一带显式 code（模型与前端都按 code 分流，不猜文案）。 */
const refusal = (code: string, error: string) => ({
  isError: true as const,
  content: [{ type: 'text' as const, text: JSON.stringify({ code, error }) }],
})

/**
 * 评论三工具的 handler（独立导出便于单测）：评论成为 AI 的一等输入。
 * docId 由按文档签发的 MCP 令牌派生（不可由参数指定）——模型只能看/回本文档的线程。
 */
export function commentToolHandlers(deps: { store: Store }, docId: string) {
  return {
    list: async (args: { status?: 'open' | 'resolved'; comment_id?: string }) => {
      const status = args.comment_id ? undefined : args.status ?? 'open'
      const comments = args.comment_id
        ? [deps.store.getComment(docId, args.comment_id)].filter(c => c !== undefined)
        : deps.store.listComments(docId, status)
      const projection = (() => {
        const doc = deps.store.getDoc(docId)
        if (!doc || doc.head_seq === 0) return undefined
        return deps.store.getProjection(docId, doc.head_seq)?.projection
      })()
      const out = comments.map(c => {
        // open 线程附锚点诊断：located + 漂移候选（模型一次修正，不盲猜）。
        const anchor = c.status === 'open' && projection ? locateAnchor(c.anchor, projection) : undefined
        return {
          comment_id: c.id, status: c.status, anchor: c.anchor, replies: c.replies.map(r => ({ role: r.role, text: r.text })),
          resolved_by: c.resolved_by, drifted: c.drifted,
          ...(anchor ? { located: anchor.located, candidates: anchor.candidates } : {}),
        }
      })
      return json({
        doc_id: docId, count: out.length, comments: out,
        note: args.comment_id && out.length === 0
          ? `未找到该评论线程（comment_id=${args.comment_id}——可能不属于本文档或 id 有误）。`
          : out.length === 0 ? `当前没有 ${status === 'resolved' ? '已关闭' : '待处理'}的评论。` : undefined,
      })
    },

    reply: async (args: { comment_id: string; text: string }) => {
      const commentId = args.comment_id?.trim() ?? ''
      const text = args.text?.trim() ?? ''
      if (!commentId) return refusal('validation_error', 'comment_id 缺失——请传 list_comments 返回的线程 id。')
      if (!text) return refusal('empty_args', 'text 缺失——请传要在线程内说明的内容。')
      if (text.length > 10000) return refusal('validation_error', `text 过长（${text.length} 字符，上限 10000）。`)
      // 双重过滤：不在本文档的线程按不存在处理。
      const comment = deps.store.getComment(docId, commentId)
      if (!comment) return refusal('unit_not_found', `评论不存在或不属于当前文档：${commentId}。`)
      const reply = deps.store.addReply(docId, commentId, 'ai', text)
      return json({ comment_id: commentId, reply_id: reply.id, role: 'ai', status: comment.status, note: '回复已写入线程（role 固定为 ai）。' })
    },

    resolve: async (args: { comment_id: string }) => {
      const commentId = args.comment_id?.trim() ?? ''
      if (!commentId) return refusal('validation_error', 'comment_id 缺失——请传要关闭的线程 id。')
      const comment = deps.store.getComment(docId, commentId)
      if (!comment) return refusal('unit_not_found', `评论不存在或不属于当前文档：${commentId}。`)
      if (comment.status === 'resolved') return refusal('unit_unchanged', `评论 ${commentId} 已是 resolved 状态，无需重复关闭。`)
      // 收口纪律：仅用于「无需改动、已说明」——最后一条回复必须是 AI。
      const last = comment.replies[comment.replies.length - 1]
      if (!last || last.role !== 'ai') {
        return refusal('validation_error',
          `线程 ${commentId} 还没有 AI 回复——resolve 仅用于「判断无需改动并已在线程内说明」。请先 reply_comment 说明，再关闭；需要改动时直接编辑文件即可（用户可随时 reopen）。`)
      }
      deps.store.resolveComment(docId, commentId, 'ai')
      return json({ comment_id: commentId, status: 'resolved', resolved_by: 'ai', note: '线程已关闭（用户可随时重新打开）。' })
    },
  }
}

/** 为某个文档构建 MCP server；工具作用域固定在 docId 上。 */
export function buildLiteratureServer(deps: LiteratureDeps, docId: string): McpServer {
  const server = new McpServer({ name: 'heurion-literature', version: '0.2.0' }, {
    instructions:
      '医学文献检索、引用登记与评论协作。正式引用必须通过 insert_citation 取得，不得手写参考文献或编造 DOI。' +
      '处理用户评论时：先 list_comments 读取锚点与要求，再编辑文件，最后 reply_comment 在线程内说明改了什么（或为什么没改）；' +
      '删除/整段重写内容前先核对该范围的 open 评论锚点，会清空锚点时先回复说明。无需改动时才用 resolve_comment 关闭线程。',
  })

  server.registerTool('pubmed_search', {
    description: '检索 PubMed，返回 PMID、DOI、标题、作者、期刊、年份。',
    inputSchema: { query: z.string().min(1).describe('PubMed 检索式，可用 MeSH 与布尔运算'), limit: z.number().int().min(1).max(20).default(10) },
  }, async ({ query, limit }) => json(await deps.pubmed.search(query, limit)))

  server.registerTool('doi_lookup', {
    description: '按 DOI 查 Crossref 元数据，用于核实一条文献是否真实存在。',
    inputSchema: { doi: z.string().min(1) },
  }, async ({ doi }) => json(await deps.crossref.lookup(doi) ?? { found: false, doi: normalizeDoi(doi) }))

  server.registerTool('insert_citation', {
    description: '登记一条正式引用并返回 AMA 格式条目。写进文档的每条参考文献都必须先调用本工具；DOI 必填，且必须能在 Crossref 查到。',
    inputSchema: { doi: z.string().min(1), pmid: z.string().optional() },
  }, async ({ doi, pmid }) => {
    const article = await deps.crossref.lookup(doi)
    if (!article) return refusal('validation_error', `DOI ${normalizeDoi(doi)} 在 Crossref 不存在，不能作为引用。`)
    const row = deps.store.upsertCitation({
      id: randomUUID(), doc_id: docId, doi: article.doi!, pmid: pmid ?? null, formatted: formatAma(article),
    })
    const index = deps.store.listCitations(docId).findIndex(c => c.doi === row.doi) + 1
    return json({ number: index, doi: row.doi, formatted: row.formatted })
  })

  server.registerTool('list_citations', {
    description: '列出本文档已登记的全部引用（按登记顺序编号），用于生成参考文献列表。',
    inputSchema: {},
  }, async () => json(deps.store.listCitations(docId).map((c, i) => ({ number: i + 1, doi: c.doi, formatted: c.formatted }))))

  const comments = commentToolHandlers(deps, docId)
  server.registerTool('list_comments', {
    description:
      '列出当前文档的评论线程（用户锚定在具体段落/形状上的编辑指令）。每条 open 线程带锚点诊断：' +
      'located=true 表示文字片段在当前版本中仍能定位；漂移时给最近候选文本。处理评论前必读——锚点就是编辑目标，' +
      '按候选/片段在文件中定位后编辑，不要凭记忆复述原文。可用 status/comment_id 过滤。',
    inputSchema: {
      status: z.enum(['open', 'resolved']).optional().describe('按状态过滤，默认 open'),
      comment_id: z.string().optional().describe('直查单条线程（处理指定评论时优先用）'),
    },
  }, comments.list)

  server.registerTool('reply_comment', {
    description:
      '在评论线程内回复（role 固定为 ai，服务端强制）。完成修改后说明改了什么/改在哪；被锚点保护拦下或无需改动时说明原因。用户会在面板里读到你写的每一条。',
    inputSchema: {
      comment_id: z.string().min(1).describe('线程 id（来自 list_comments 或触发上下文）'),
      text: z.string().min(1).max(10000).describe('回复内容：改了什么、改在哪，或为什么没改'),
    },
  }, comments.reply)

  server.registerTool('resolve_comment', {
    description:
      '关闭评论线程。仅用于「判断无需改动、且已用 reply_comment 在线程内说明」的收口（最后一条回复必须是 AI，否则拒绝）。' +
      '需要改动的评论不要 resolve——直接编辑文件即可，用户可随时 reopen。',
    inputSchema: { comment_id: z.string().min(1).describe('要关闭的线程 id') },
  }, comments.resolve)

  return server
}

/** 无状态 Streamable HTTP：每个请求新建 server + transport。 */
export async function handleMcpRequest(deps: LiteratureDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = req.headers.authorization ?? ''
  const docId = auth.startsWith('Bearer ') ? verifyDocToken(deps.secret, auth.slice(7)) : null
  if (!docId || !deps.store.getDoc(docId)) {
    res.writeHead(401).end('unauthorized')
    return
  }
  const server = buildLiteratureServer(deps, docId)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => { void transport.close(); void server.close() })
  await server.connect(transport)
  await transport.handleRequest(req, res)
}
