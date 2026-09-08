/**
 * 方案 2 — search_openalex:OpenAlex 2.5 亿+ 学术作品检索
 * (search = 标题 + 摘要 + 全文倒排索引)。与 search_citation(PubMed)互补:
 * 覆盖非生物医学引文、引文影响力(cited_by_count)、OA 状态与期刊画像。
 * 数据面走 #835 externalRequest(openalex host:节流 + 24h 缓存 + polite pool)。
 */
import { BaseTool, type ToolResult } from './base-tool.js'
import { externalRequest } from './external-fetch.js'

interface RawWork {
  id?: string
  doi?: string | null
  title?: string | null
  display_name?: string | null
  publication_year?: number | null
  cited_by_count?: number | null
  type?: string | null
  open_access?: { is_oa?: boolean; oa_status?: string | null } | null
  primary_location?: { source?: { display_name?: string | null } | null } | null
  authorships?: Array<{ author?: { display_name?: string | null } | null }> | null
}

interface SearchArgs {
  query?: string
  from_year?: number
  to_year?: number
  source_name?: string
  open_access_only?: boolean
  sort_by_citations?: boolean
  per_page?: number
}

const WORK_SELECT = 'id,doi,title,display_name,publication_year,cited_by_count,type,open_access,primary_location,authorships'

export class SearchOpenAlexTool extends BaseTool {
  constructor(_ctx?: unknown) { super() }

  get name(): string { return 'search_openalex' }

  get description(): string {
    return 'Search OpenAlex, an open index of 250M+ scholarly works (searches title, abstract, and fulltext). '
      + 'Use search_citation (PubMed) FIRST for clinical/biomedical literature; use THIS tool for coverage beyond PubMed '
      + '(non-biomedical fields, preprints, social sciences), citation-impact checks (cited_by_count), open-access status, '
      + 'and journal-scoped searches via source_name. Returns title/year/venue/DOI/citation count/OA per work. Read-only.'
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query — keywords, a claim to verify, or a paper title. Searches titles, abstracts and fulltext.' },
        from_year: { type: 'number', description: 'Optional: restrict to works published in or after this year.' },
        to_year: { type: 'number', description: 'Optional: restrict to works published in or before this year.' },
        source_name: { type: 'string', description: 'Optional: restrict to one journal/source by name (e.g. "Nature"). Matched against OpenAlex source display names.' },
        open_access_only: { type: 'boolean', description: 'Optional: only return works with an OA fulltext location.' },
        sort_by_citations: { type: 'boolean', description: 'Optional: sort by cited_by_count desc instead of relevance (default).' },
        per_page: { type: 'number', description: 'Optional: results to return, 1-10 (default 5).' },
      },
      required: ['query'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const a = args as SearchArgs
    const query = String(a.query || '').trim()
    if (!query) return { success: false, error: 'query is required' }
    const perPage = Math.min(Math.max(Number(a.per_page) || 5, 1), 10)

    const filters: string[] = []
    if (a.from_year && a.to_year) filters.push(`publication_year:${Math.trunc(a.from_year)}-${Math.trunc(a.to_year)}`)
    else if (a.from_year) filters.push(`from_publication_date:${Math.trunc(a.from_year)}-01-01`)
    else if (a.to_year) filters.push(`to_publication_date:${Math.trunc(a.to_year)}-12-31`)
    if (a.open_access_only) filters.push('is_oa:true')

    // source_name → 先查 source id(名称精确匹配,沿用选刊侧的归一化匹配策略)
    let sourceName: string | undefined
    if (a.source_name && String(a.source_name).trim()) {
      try {
        const raw = await externalRequest('openalex', '/sources', {
          filter: `display_name.search:${String(a.source_name).trim().slice(0, 120)}`,
          per_page: '1',
          select: 'id,display_name',
        })
        const s = JSON.parse(raw) as { results?: Array<{ id?: string; display_name?: string }> }
        const hit = s.results?.[0]
        if (hit?.id) {
          filters.push(`primary_location.source.id:${hit.id.replace('https://openalex.org/', '')}`)
          sourceName = hit.display_name
        }
      } catch { /* source 解析失败 → 退化为全库检索,不阻塞 */ }
    }

    try {
      const raw = await externalRequest('openalex', '/works', {
        search: query.slice(0, 300),
        ...(filters.length > 0 ? { filter: filters.join(',') } : {}),
        per_page: String(perPage),
        select: WORK_SELECT,
        ...(a.sort_by_citations ? { sort: 'cited_by_count:desc' } : {}),
      })
      const data = JSON.parse(raw) as { results?: RawWork[]; meta?: { count?: number } }
      const works = data.results ?? []
      if (works.length === 0) {
        return { success: true, output: `OpenAlex: no works matched "${query}"${sourceName ? ` in ${sourceName}` : ''}. Try broader terms or remove filters.` }
      }
      const lines = works.map((w, i) => {
        const title = String(w.display_name ?? w.title ?? '(untitled)')
        const authors = (w.authorships ?? []).map((x) => x.author?.display_name).filter(Boolean) as string[]
        const venue = w.primary_location?.source?.display_name
        const oa = w.open_access?.is_oa ? `OA(${w.open_access.oa_status ?? 'oa'})` : 'closed'
        const doi = w.doi ? String(w.doi).replace('https://doi.org/', '') : 'no-doi'
        return [
          `${i + 1}. ${title}`,
          `   ${authors.length > 0 ? `${authors[0]}${authors.length > 1 ? ' et al.' : ''} · ` : ''}${w.publication_year ?? 'n.d.'} · ${venue ?? 'unknown venue'} · ${w.type ?? 'article'} · cited_by ${w.cited_by_count ?? 0} · ${oa}`,
          `   DOI: ${doi}`,
        ].join('\n')
      })
      const total = data.meta?.count
      const header = sourceName ? `OpenAlex search "${query}" in ${sourceName}` : `OpenAlex search "${query}"`
      return { success: true, output: `${header} — ${total ?? works.length} matches, top ${works.length}:\n\n${lines.join('\n\n')}` }
    } catch (err) {
      return { success: false, error: `search_openalex failed: ${(err as Error).message.slice(0, 300)}` }
    }
  }
}
