import { BaseTool, ToolResult } from './base-tool.js'
import type { ToolContext } from './tool-registry.js'

/**
 * #807 — search_citation: 引用实体化第一块。学术写作零容忍编造：References
 * 里的 PMID/年份/作者必须来自真实检索。本工具直连 PubMed E-utilities
 * （esearch → esummary），返回 AMA 格式引用串 + 结构化元数据。
 * 与 search_medical_web 的区别：本工具输出**引用级**元数据（可进
 * References），不做全文/摘要检索。
 *
 * #835: 生产实测写作回合每轮并行 3 个查询 × 连续 5 轮 → NCBI 无 key 限
 * 3 req/s → HTTP 429 大面积失败(检索/读取 折叠组全红)。对策:
 * ① 全局节流阀(无 key 400ms/请求 ≈2.5 req/s;配 NCBI_API_KEY 后 120ms);
 * ② 429/5xx 退避重试一次(尊重 Retry-After);
 * ③ 5 分钟请求缓存 — 模型同回合重复相似查询不再烧配额。
 */
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
const FETCH_TIMEOUT_MS = 15000
const MIN_INTERVAL_MS = process.env.NCBI_API_KEY ? 120 : 400
const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX = 200

/** 全局节流阀 — 串行化所有 eutils 请求并保证最小间隔(并行 read-only 组不超速)。 */
let eutilsChain: Promise<void> = Promise.resolve()
let lastEutilsAt = 0

async function eutilsGate(): Promise<void> {
  const task = eutilsChain.then(async () => {
    const wait = lastEutilsAt + MIN_INTERVAL_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastEutilsAt = Date.now()
  })
  eutilsChain = task.catch(() => {})
  return task
}

/** 测试钩子:重置节流阀与缓存。 */
export function resetEutilsState(): void {
  eutilsChain = Promise.resolve()
  lastEutilsAt = 0
  responseCache.clear()
}

interface CacheEntry { at: number; body: unknown }
const responseCache = new Map<string, CacheEntry>()

function cacheGet(key: string): unknown | undefined {
  const hit = responseCache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    responseCache.delete(key)
    return undefined
  }
  return hit.body
}

function cacheSet(key: string, body: unknown): void {
  responseCache.set(key, { at: Date.now(), body })
  if (responseCache.size > CACHE_MAX) {
    // Map 迭代序 = 插入序,淘汰最旧。
    const oldest = responseCache.keys().next().value
    if (oldest !== undefined) responseCache.delete(oldest)
  }
}

interface EutilsResult { body: unknown; retryAfterMs?: number }

async function eutilsFetchOnce(path: string, url: string): Promise<EutilsResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Heurion/1.0 (medical research agent)' } })
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get('retry-after')) || 0
      return { body: null, retryAfterMs: Math.max(ra * 1000, 1200) }
    }
    if (!res.ok) throw new Error(`PubMed HTTP ${res.status}`)
    return { body: await res.json() }
  } finally {
    clearTimeout(timer)
  }
}

async function eutilsJson(path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${EUTILS}/${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const apiKey = process.env.NCBI_API_KEY
  if (apiKey) url.searchParams.set('api_key', apiKey)
  const cacheKey = url.toString()
  const cached = cacheGet(cacheKey)
  if (cached !== undefined) return cached

  for (let attempt = 0; attempt < 2; attempt++) {
    await eutilsGate()
    const { body, retryAfterMs } = await eutilsFetchOnce(path, url.toString())
    if (retryAfterMs !== undefined) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, retryAfterMs))
        continue
      }
      throw new Error(`PubMed HTTP 429（已退避重试仍限流）`)
    }
    cacheSet(cacheKey, body)
    return body
  }
  throw new Error('PubMed request failed')
}

interface CitationRecord {
  pmid: string
  title: string
  authors: string[]
  journal: string
  year: string
  volume?: string
  pages?: string
  doi?: string
  /** AMA 格式（作者 ≤3 全列,>3 前三+et al.） */
  ama: string
}

function formatAma(r: Omit<CitationRecord, 'ama'>): string {
  const a = r.authors.filter(Boolean)
  const authors = a.length === 0 ? '' : a.length <= 3 ? `${a.join(', ')}.` : `${a.slice(0, 3).join(', ')}, et al.`
  const doi = r.doi ? ` doi: ${r.doi}` : ''
  return `${authors} ${r.title}. ${r.journal}. ${r.year}${r.volume ? `;${r.volume}` : ''}${r.pages ? `:${r.pages}` : ''}.${doi} PMID: ${r.pmid}.`
}


export class SearchCitationTool extends BaseTool {
  constructor(_ctx: ToolContext) {
    super()
  }

  get name(): string { return 'search_citation' }

  get description(): string {
    return [
      'Search PubMed for REAL, verifiable citations (PMID/authors/year/journal/DOI) and get AMA-formatted reference strings.',
      'Use this EVERY time you add or edit references/citations in a document — NEVER invent PMID, authors, years or DOIs.',
      'If no result matches, say so honestly instead of fabricating. Returns up to 8 citations per query.',
    ].join(' ')
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Citation search query — topic, title keywords, author, or combination (e.g. "EGFR mutant NSCLC pembrolizumab real-world").' },
        retmax: { type: 'number', description: 'Max citations to return (default 5, max 8).' },
      },
      required: ['query'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query) return { success: false, error: 'query is required' }
    const retmax = Math.min(Math.max(Number(args.retmax) || 5, 1), 8)
    try {
      const search = await eutilsJson('esearch.fcgi', { db: 'pubmed', term: query, retmode: 'json', retmax: String(retmax), sort: 'relevance' })
      const ids: string[] = search?.esearchresult?.idlist ?? []
      if (ids.length === 0) {
        return { success: true, output: `PubMed 未找到与「${query}」匹配的文献 — 请调整关键词重试，或如实告知用户无法确认该引用。禁止编造。` }
      }
      const summary = await eutilsJson('esummary.fcgi', { db: 'pubmed', id: ids.join(','), retmode: 'json' })
      const docs = summary?.result ?? {}
      const citations: CitationRecord[] = ids
        .filter((pmid) => docs[pmid])
        .map((pmid) => {
          const d = docs[pmid]
          const record = {
            pmid,
            title: String(d.title || '').replace(/\.$/, ''),
            authors: Array.isArray(d.authors) ? d.authors.map((a: any) => String(a.name || '')).filter(Boolean) : [],
            journal: String(d.fulljournalname || d.source || ''),
            year: String(d.pubdate || '').slice(0, 4) || '',
            volume: String(d.volume || ''),
            pages: String(d.pages || ''),
            doi: (Array.isArray(d.summaryids) ? d.summaryids.find((x: any) => x.idtype === 'doi')?.value : '') || undefined,
          }
          return { ...record, ama: formatAma(record) }
        })
      const body = citations.map((c, i) => `${i + 1}. ${c.ama}`).join('\n')
      const output = `共 ${citations.length} 条真实引用（可直接用于 References，格式 AMA）：\n${body}\n\n提醒：只能引用以上检索到的文献；写进文档时保留 PMID 以便核对。`
      return { success: true, output }
    } catch (err) {
      return { success: false, error: `PubMed 检索失败: ${(err as Error).message.slice(0, 200)} — 请如实告知用户引用暂不可验证，禁止编造。` }
    }
  }
}
