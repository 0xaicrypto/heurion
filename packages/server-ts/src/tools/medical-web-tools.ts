/**
 * #356 phase 1: medical web access tools — PubMed E-utilities (free,
 * no key). search_medical_web → structured article list; fetch_article_summary
 * → PMID/DOI abstract. Read-only; every search is recorded on the event log
 * (audit). Stage 2 (Kitesurf browsing) lands later.
 */
import { BaseTool, ToolResult } from './base-tool.js'
import type { ToolContext } from './tool-registry.js'

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
const FETCH_TIMEOUT_MS = 15000
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

async function eutilsFetch(path: string, params: Record<string, string>, ctx?: ToolContext, queryForAudit?: string): Promise<string> {
  const url = new URL(`${EUTILS}/${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url.toString(), { signal: controller.signal, headers: { 'User-Agent': 'Heurion/1.0 (medical research agent)' } })
    if (!res.ok) {
      throw new Error(`PubMed HTTP ${res.status}`)
    }
    const text = await res.text()
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
  } finally {
    clearTimeout(timer)
  }
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
    return 'Fetch a PubMed article summary (title, authors, journal, abstract, DOI) by PMID or DOI. Use to verify a citation or read the abstract before citing. Read-only.'
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

async function browserRunMarkdown(url: string, ctx: ToolContext, auditLabel: string): Promise<{ markdown: string; title: string }> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!accountId || !token) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN not configured — browser access unavailable')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const res = await fetch(`${CF_BROWSER_RUN}/${accountId}/browser-run/markdown?browser=kitesurf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url }),
      signal: controller.signal,
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
    return 'Open a medical website (journal article page, guideline page, PubMed record) in a headless browser and read the rendered content as markdown. Use when PubMed search results are not enough and the full page context matters. Read-only; requires Cloudflare Browser Run configured.'
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
    try {
      const { markdown, title } = await browserRunMarkdown(url, this.ctx, url)
      if (!markdown) return { success: false, error: 'Browser Run returned no content' }
      return {
        success: true,
        output: `Page: ${title || url}\n\n${markdown.slice(0, 8000)}`,
      }
    } catch (err) {
      return { success: false, error: `visit_medical_site failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}

/** #356: full-text extraction from an already-visited medical page. */
export class ExtractFulltextTool extends BaseTool {
  constructor(private ctx: ToolContext) { super() }

  get name(): string { return 'extract_fulltext' }
  get description(): string {
    return 'Extract the full text of a medical article or guideline page via headless browser rendering. Returns the page as clean markdown. Read-only; requires Cloudflare Browser Run configured.'
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
    try {
      const { markdown } = await browserRunMarkdown(url, this.ctx, url)
      if (!markdown) return { success: false, error: 'Browser Run returned no content' }
      return { success: true, output: markdown.slice(0, 16000) }
    } catch (err) {
      return { success: false, error: `extract_fulltext failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}
