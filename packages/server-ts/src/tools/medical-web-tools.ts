/**
 * #356 phase 1: medical web access tools — PubMed E-utilities (free,
 * no key). search_medical_web → structured article list; fetch_article_summary
 * → PMID/DOI abstract. Read-only; every search is recorded on the event log
 * (audit). Stage 2 (Kitesurf browsing) lands later.
 */
import { BaseTool, ToolResult } from './base-tool.js'
import type { ToolContext } from './tool-registry.js'

const MAX_RESULTS = 10

interface PubmedArticle {
  pmid: string
  title: string
  authors: string[]
  journal: string
  year?: string
  abstract: string
  doi?: string
}

/**
 * #837: eutils 调用统一走 search-citation 的共享管道(api_key + 进程级
 * 节流阀 + 缓存 + 429 退避) — 此前本模块直连 NCBI,绕过全部限速治理,
 * 主 chat 的 PubMed 流量实际不受控。
 */
import { eutilsRequest } from './search-citation-tool.js'
import { crossrefResolveDoi, formatCrossrefSummary, looksLikeDoi } from './crossref.client.js'
import { normalizeCacheKey } from './url-cache/normalize.js'
import { cacheGet, cacheSet } from './url-cache/store.js'
import { makeLogger } from '../common/logger.js'

async function eutilsFetch(path: string, params: Record<string, string>, ctx?: ToolContext, queryForAudit?: string): Promise<string> {
  const text = await eutilsRequest(path, params, { signal: ctx?.signal })
  if (ctx && queryForAudit) {
    try {
      ctx.eventLog.append({
        timestamp: Date.now() / 1000,
        eventType: 'evolution',
        content: `🔎 医学文献检索：${queryForAudit}`,
        metadata: { action: 'medical_web_search', query: queryForAudit, source: 'pubmed' },
        agentId: ctx.userId,
        sessionId: ctx.sessionId || '',
      })
    } catch {
      /* audit is best-effort */
    }
  }
  return text
}

function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

/** Parse an efetch XML blob into articles. */
function parsePubmedXml(xml: string): PubmedArticle[] {
  const articles: PubmedArticle[] = []
  const docRegex = /<PubmedArticle>[\s\S]*?<\/PubmedArticle>/g
  const matches = xml.match(docRegex) || []
  for (const doc of matches) {
    const pmid = doc.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1] || ''
    if (!pmid) continue
    const title = xmlUnescape(doc.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/)?.[1] || '').trim()
    const journal = xmlUnescape(doc.match(/<Title>([\s\S]*?)<\/Title>/)?.[1] || '').trim()
    const year = doc.match(/<PubDate>\s*<Year>(\d{4})<\/Year>/)?.[1]
    const abstract = xmlUnescape((doc.match(/<Abstract>[\s\S]*?<\/Abstract>/) || [''])[0])
      .replace(/<AbstractText[^>]*>/g, ' ')
      .replace(/<\/AbstractText>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const doi = doc.match(/<ELocationID EIdType="doi"[^>]*>([^<]+)<\/ELocationID>/)?.[1]
    const authors = Array.from(doc.matchAll(/<LastName>([^<]+)<\/LastName>/g)).map((m) => m[1])
    articles.push({ pmid, title, authors: authors.slice(0, 6), journal, year, abstract: abstract.slice(0, 2000), doi })
  }
  return articles
}

/** #356: PubMed search — structured retrieval by query. */
export class SearchMedicalWebTool extends BaseTool {
  constructor(private ctx: ToolContext) { super() }

  get name(): string { return 'search_medical_web' }
  get description(): string {
    return 'Search PubMed (MEDLINE) for medical literature. Returns structured results (PMID, title, journal, year, authors, abstract preview). Use for literature review, guideline evidence, and citation hunting. Read-only.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'PubMed query, e.g. "EGFR NSCLC immunotherapy survival"' },
        limit: { type: 'integer', default: 5, description: 'Max results (1-10)' },
        date_range: { type: 'string', description: 'e.g. "2020:2024[dp]" or "5 years"' },
      },
      required: ['query'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args.query || '').trim()
    if (!query) return { success: false, error: 'query is required' }
    const limit = Math.min(MAX_RESULTS, Math.max(1, Number(args.limit) || 5))
    const dateRange = args.date_range ? String(args.date_range) : ''

    try {
      const term = `${query}${dateRange ? ` AND ${dateRange}` : ''}`
      const esearch = await eutilsFetch('esearch.fcgi', {
        db: 'pubmed',
        term,
        retmax: String(limit),
        retmode: 'json',
        sort: 'relevance',
      }, this.ctx, query)
      const ids: string[] = JSON.parse(esearch)?.esearchresult?.idlist || []
      if (ids.length === 0) {
        return { success: true, output: 'PubMed returned no results for this query.' }
      }

      const efetch = await eutilsFetch('efetch.fcgi', {
        db: 'pubmed',
        id: ids.join(','),
        retmode: 'xml',
        rettype: 'abstract',
      })
      const articles = parsePubmedXml(efetch).slice(0, limit)

      const lines = articles.map((a, i) => {
        const authors = a.authors.length ? a.authors.join(', ') : 'n/a'
        const date = a.year ? ` (${a.year})` : ''
        return `${i + 1}. ${a.title}${date}\n   Journal: ${a.journal}\n   Authors: ${authors}\n   PMID: ${a.pmid}${a.doi ? ` | DOI: ${a.doi}` : ''}\n   Abstract: ${(a.abstract || 'n/a').slice(0, 400)}`
      })
      return { success: true, output: `PubMed results for "${query}" (${articles.length}):\n\n${lines.join('\n\n')}` }
    } catch (err) {
      return { success: false, error: `search_medical_web failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}

/** #356: fetch an article summary by PMID or DOI. */
export class FetchArticleSummaryTool extends BaseTool {
  constructor(private ctx: ToolContext) { super() }

  get name(): string { return 'fetch_article_summary' }
  get description(): string {
    return 'Fetch an article summary (title, authors, journal, abstract, DOI) by PMID or DOI. #836: DOI inputs resolve via Crossref first (faster, saves PubMed quota; abstract only available via PubMed). Use to verify a citation or read the abstract before citing. Read-only.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        pmid: { type: 'string', description: 'PubMed ID, e.g. "32500001"' },
        doi: { type: 'string', description: 'DOI, e.g. "10.1056/NEJMoa2004416" (alternative to pmid)' },
      },
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const pmid = String(args.pmid || '').trim()
    const doi = String(args.doi || '').trim()
    if (!pmid && !doi) return { success: false, error: 'Provide either pmid or doi' }

    try {
      let id = pmid
      if (!id && doi) {
        // #836: DOI 优先走 Crossref 直解 — 省一次 PubMed esearch 绕路配额;
        // Crossref 失败(如网络/限流)回落 PubMed esearch [aid] 原路径。
        try {
          const cr = await crossrefResolveDoi(doi)
          if (cr) {
            return { success: true, output: formatCrossrefSummary(cr) }
          }
          if (!looksLikeDoi(doi)) {
            return { success: false, error: `DOI 形式不合法: ${doi} — 应形如 10.1056/NEJMoa2004416` }
          }
          // 404(null)且 DOI 形式合法 → Crossref 无记录,继续 PubMed 兜底
        } catch { /* Crossref 失败 → PubMed 兜底 */ }
        const esearch = await eutilsFetch('esearch.fcgi', {
          db: 'pubmed',
          term: `${doi}[aid]`,
          retmax: '1',
          retmode: 'json',
        })
        const list: string[] = JSON.parse(esearch)?.esearchresult?.idlist || []
        if (list.length === 0) return { success: true, output: `No PubMed record found for DOI ${doi}` }
        id = list[0]
      }

      const efetch = await eutilsFetch('efetch.fcgi', {
        db: 'pubmed',
        id,
        retmode: 'xml',
        rettype: 'abstract',
      }, this.ctx, pmid ? `PMID ${pmid}` : `DOI ${doi}`)
      const article = parsePubmedXml(efetch)[0]
      if (!article) return { success: false, error: `No article found for PMID ${id}` }

      return {
        success: true,
        output: `Title: ${article.title}\nJournal: ${article.journal}${article.year ? ` (${article.year})` : ''}\nAuthors: ${article.authors.join(', ') || 'n/a'}\nPMID: ${article.pmid}${article.doi ? ` | DOI: ${article.doi}` : ''}\n\nAbstract:\n${article.abstract || 'No abstract available'}`,
      }
    } catch (err) {
      return { success: false, error: `fetch_article_summary failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}

/**
 * #356 stage 2: browser-based medical site access via Cloudflare Browser
 * Run (Kitesurf). Renders the page and extracts markdown/full text.
 * Requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN; degrades with a
 * clear error when unconfigured.
 */
const CF_BROWSER_RUN = 'https://api.cloudflare.com/client/v4/accounts'

// #835: 站点反爬的优雅降级 — ASCO/ESMO 等强反爬站对 Browser Run 返回空内容,
// 模型此前会换着 URL 反复重试(参数不同,doom-loop 不触发),烧完 5 轮后
// 回合无产出,用户看到"不能继续写了"。三层对策:
// ① 直连抓取兜底(多数静态渲染页可绕过);
// ② 会话级 blocked-host 记忆(同 host 重复访问秒拒,不再烧轮次);
// ③ 失败信息携带行为指引(告知模型停止重试、基于已有资料继续并如实标注)。

/** 会话级反爬记忆:sessionId → { hosts, expires },30 分钟 TTL。 */
const BLOCKED_HOSTS_TTL_MS = 30 * 60 * 1000
const blockedHostsBySession = new Map<string, { hosts: Set<string>; expires: number }>()

function noteBlockedHost(sessionId: string, host: string): void {
  if (!sessionId) return
  const now = Date.now()
  const entry = blockedHostsBySession.get(sessionId)
  if (entry && entry.expires > now) {
    entry.hosts.add(host)
    return
  }
  blockedHostsBySession.set(sessionId, { hosts: new Set([host]), expires: now + BLOCKED_HOSTS_TTL_MS })
}

function isHostBlocked(sessionId: string, host: string): boolean {
  const entry = blockedHostsBySession.get(sessionId)
  if (!entry) return false
  if (entry.expires <= Date.now()) {
    blockedHostsBySession.delete(sessionId)
    return false
  }
  return entry.hosts.has(host)
}

/** 测试钩子:清空反爬记忆。 */
export function clearBlockedHosts(): void {
  blockedHostsBySession.clear()
}

const DIRECT_FETCH_TIMEOUT_MS = 15000
const DIRECT_FETCH_MIN_CHARS = 300

/**
 * 直连抓取:普通 HTTP GET + turndown HTML→markdown。
 * 不走浏览器 — 快(15s 超时内)、免费、且对服务端渲染页(ALOOC/指南/NCT 页等)
 * 命中率高;被反爬或返回空时返回空串,由调用方降级到 Browser Run。
 */
async function directFetchMarkdown(url: string, ctx: ToolContext): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DIRECT_FETCH_TIMEOUT_MS)
  const signal = ctx.signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([controller.signal, ctx.signal])
    : controller.signal
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      },
      redirect: 'follow',
      signal,
    })
    if (!res.ok) return ''
    const ct = res.headers.get('content-type') || ''
    if (!/text\/html|application\/xhtml|text\/plain/.test(ct)) return ''
    const body = await res.text()
    if (body.length < 500) return ''
    const { default: TurndownService } = await import('turndown')
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
    const markdown = td.turndown(body)
    return markdown.trim().length >= DIRECT_FETCH_MIN_CHARS ? markdown.slice(0, 20000) : ''
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/**
 * #837: NCBI E-utilities API 端点守卫。
 * 生产实例:模型把 PubMed 检索式拼成 esearch.fcgi URL 用 visit_medical_site
 * 抓取 → 被反爬拦截判「PubMed 被封」→ 触发降级把全部检索工具停用。
 * API 端点不是网页,永远不该走网页抓取 — 命中即返回成功+改道指引
 * (不标黑名单、不进检索失败计数)。
 */
export function isStructuredApiEndpoint(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.hostname === 'eutils.ncbi.nlm.nih.gov' || u.hostname === 'api.ncbi.nlm.nih.gov') return true
    if (u.hostname.endsWith('.ncbi.nlm.nih.gov') && u.pathname.includes('entrez/eutils')) return true
    return false
  } catch {
    return false
  }
}

const EUTILS_MISUSE_GUIDANCE = 'eutils.ncbi.nlm.nih.gov 是 NCBI E-utilities 结构化 API 端点，不是网页 — 本工具不抓取 API。检索 PubMed 请改用 search_citation 工具（内置限速/缓存/API key，传入检索式而非拼好的 URL）。'

/**
 * 医学页面统一抓取入口:缓存 → 直连 → Browser Run → 诚实失败(带停止重试指引)。
 * 同会话重复抓取已确认拦截的 host 会立即秒拒,不再消耗工具轮次。
 * #861: page_md 持久缓存(#857/#859)— 入口查缓存(命中直接返回,跳过
 * 直连与 Browser Run 计费路径);direct/browser 成功后写回;两路皆空时
 * 先回退过期缓存(stale-on-error),无才走 blocked-host 抛错。
 * TTL 7 天(URL_CACHE_TTL_PAGE_H,文献页面发布后近乎不可变);
 * `URL_CACHE_ENABLED=false` 关闭。
 */
async function fetchMedicalPageMarkdown(url: string, ctx: ToolContext, auditLabel: string): Promise<{ markdown: string; title: string }> {
  const host = hostOf(url)
  const sessionId = ctx.sessionId || ''
  if (isHostBlocked(sessionId, host)) {
    throw new Error(`站点 ${host} 已在本会话确认为反爬拦截（直接抓取与浏览器渲染均无内容），已停止尝试。请基于已有资料继续当前任务，勿再请求该站点；如需引用请在文中如实标注"来源未能核实"。`)
  }
  // #861: page_md 持久缓存 — key 归一化(#858),TTL 天级(页面近不可变)。
  const cacheEnabled = process.env.URL_CACHE_ENABLED !== 'false'
  const pageTtlMs = (Number(process.env.URL_CACHE_TTL_PAGE_H) || 168) * 3600_000
  let staleFallback: string | undefined
  if (cacheEnabled) {
    try {
      const hit = cacheGet('page_md', normalizeCacheKey(url))
      if (hit) {
        if (!hit.stale) {
          try {
            ctx.eventLog.append({
              timestamp: Date.now() / 1000,
              eventType: 'evolution',
              content: `🌐 站点访问：${auditLabel}`,
              metadata: { action: 'medical_web_visit', url, source: 'cache' },
              agentId: ctx.userId,
              sessionId,
            })
          } catch { /* best-effort */ }
          return { markdown: hit.body, title: '' }
        }
        staleFallback = hit.body
      }
    } catch { /* 缓存故障降级直连 */ }
  }
  // ① 直连抓取
  const direct = await directFetchMarkdown(url, ctx)
  if (direct) {
    if (cacheEnabled) cacheSet('page_md', normalizeCacheKey(url), direct, pageTtlMs)
    try {
      ctx.eventLog.append({
        timestamp: Date.now() / 1000,
        eventType: 'evolution',
        content: `🌐 站点访问：${auditLabel}`,
        metadata: { action: 'medical_web_visit', url, source: 'direct-fetch' },
        agentId: ctx.userId,
        sessionId,
      })
    } catch { /* best-effort */ }
    return { markdown: direct, title: '' }
  }
  // ② Browser Run
  try {
    const viaBrowser = await browserRunMarkdown(url, ctx, auditLabel)
    if (viaBrowser.markdown) {
      if (cacheEnabled) cacheSet('page_md', normalizeCacheKey(url), viaBrowser.markdown, pageTtlMs)
      return viaBrowser
    }
  } catch { /* fall through to honest failure */ }
  // ③ stale-on-error:两路皆空 — 过期缓存优于抛错(#857 对症药)
  if (staleFallback !== undefined) {
    makeLogger('tools.medical-web').warn(`[medical-web] stale page cache served: ${host}`)
    return { markdown: staleFallback, title: '' }
  }
  // ④ 两路皆空且无缓存 — 记忆并给出行为指引
  noteBlockedHost(sessionId, host)
  throw new Error(`站点 ${host} 禁止自动化访问（反爬拦截）：直接抓取与浏览器渲染均未获得内容。请勿继续重试该站点；请基于已有资料继续当前任务，如需引用请在文中如实标注"来源未能核实"。`)
}

async function browserRunMarkdown(url: string, ctx: ToolContext, auditLabel: string): Promise<{ markdown: string; title: string }> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!accountId || !token) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN not configured — browser access unavailable')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  // #828: turn abort awareness (same combination as eutilsFetch).
  const signal = ctx.signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([controller.signal, ctx.signal])
    : controller.signal
  try {
    const res = await fetch(`${CF_BROWSER_RUN}/${accountId}/browser-run/markdown?browser=kitesurf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url }),
      signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Browser Run HTTP ${res.status}: ${text.slice(0, 150)}`)
    }
    const data: any = await res.json()
    const markdown = String(data?.markdown || data?.result?.markdown || '')
    if (ctx) {
      try {
        ctx.eventLog.append({
          timestamp: Date.now() / 1000,
          eventType: 'evolution',
          content: `🌐 站点访问：${auditLabel}`,
          metadata: { action: 'medical_web_visit', url, source: 'browser-run' },
          agentId: ctx.userId,
          sessionId: ctx.sessionId || '',
        })
      } catch { /* best-effort */ }
    }
    return { markdown: markdown.slice(0, 20000), title: String(data?.title || '') }
  } finally {
    clearTimeout(timer)
  }
}

/** #356: visit a medical site (journal page, guideline) and read it. */
export class VisitMedicalSiteTool extends BaseTool {
  constructor(private ctx: ToolContext) { super() }

  get name(): string { return 'visit_medical_site' }
  get description(): string {
    return 'Open a medical website (journal article page, guideline page) and read the rendered content as markdown. Tries a direct fetch first, then headless browser rendering. Read-only. If a site blocks automated access, do NOT retry it — continue with available material. NEVER use this tool for NCBI E-utilities API endpoints (eutils.ncbi.nlm.nih.gov, entrez/eutils URLs) — use the search_citation tool for PubMed queries instead.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL, e.g. https://pubmed.ncbi.nlm.nih.gov/32500001/' },
      },
      required: ['url'],
    }
  }
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const url = String(args.url || '').trim()
    if (!/^https?:\/\//.test(url)) return { success: false, error: 'url must start with http(s)://' }
    // #837: NCBI API 端点误用 — 成功返回改道指引(不计失败、不标黑名单)。
    if (isStructuredApiEndpoint(url)) return { success: true, output: EUTILS_MISUSE_GUIDANCE }
    try {
      const { markdown, title } = await fetchMedicalPageMarkdown(url, this.ctx, url)
      return {
        success: true,
        output: `Page: ${title || url}\n\n${markdown.slice(0, 8000)}`,
      }
    } catch (err) {
      return { success: false, error: `visit_medical_site failed: ${(err as Error).message.slice(0, 300)}` }
    }
  }
}

/** #356: full-text extraction from an already-visited medical page. */
export class ExtractFulltextTool extends BaseTool {
  constructor(private ctx: ToolContext) { super() }

  get name(): string { return 'extract_fulltext' }
  get description(): string {
    return 'Extract the full text of a medical article or guideline page. Tries a direct fetch first, then headless browser rendering. Returns the page as clean markdown. Read-only. If a site blocks automated access, do NOT retry it — continue with available material and mark the source as unverified.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL of the article/guideline page' },
      },
      required: ['url'],
    }
  }
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const url = String(args.url || '').trim()
    if (!/^https?:\/\//.test(url)) return { success: false, error: 'url must start with http(s)://' }
    // #837: NCBI API 端点误用 — 成功返回改道指引(不计失败、不标黑名单)。
    if (isStructuredApiEndpoint(url)) return { success: true, output: EUTILS_MISUSE_GUIDANCE }
    try {
      const { markdown } = await fetchMedicalPageMarkdown(url, this.ctx, url)
      return { success: true, output: markdown.slice(0, 16000) }
    } catch (err) {
      return { success: false, error: `extract_fulltext failed: ${(err as Error).message.slice(0, 300)}` }
    }
  }
}
