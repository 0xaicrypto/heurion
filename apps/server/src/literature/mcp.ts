import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { Store } from '../db.ts'
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

/** 为某个文档构建 MCP server；工具作用域固定在 docId 上。 */
export function buildLiteratureServer(deps: LiteratureDeps, docId: string): McpServer {
  const server = new McpServer({ name: 'heurion-literature', version: '0.1.0' }, {
    instructions: '医学文献检索与引用登记。正式引用必须通过 insert_citation 取得，不得手写参考文献或编造 DOI。',
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
    if (!article) return { isError: true, content: [{ type: 'text' as const, text: `DOI ${normalizeDoi(doi)} 在 Crossref 不存在，不能作为引用。` }] }
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
