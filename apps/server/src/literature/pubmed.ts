import type { Article, FetchLike } from './types.ts'

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'

interface SummaryDoc {
  uid: string
  title?: string
  fulljournalname?: string
  source?: string
  pubdate?: string
  volume?: string
  issue?: string
  pages?: string
  authors?: { name: string }[]
  articleids?: { idtype: string; value: string }[]
}

export class PubMedClient {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly apiKey = '',
    private readonly email = '',
  ) {}

  private url(path: string, params: Record<string, string>): string {
    const q = new URLSearchParams({ ...params, retmode: 'json', tool: 'heurion2' })
    if (this.apiKey) q.set('api_key', this.apiKey)
    if (this.email) q.set('email', this.email)
    return `${EUTILS}/${path}?${q}`
  }

  async search(query: string, limit = 10): Promise<Article[]> {
    const res = await this.fetchImpl(this.url('esearch.fcgi', { db: 'pubmed', term: query, retmax: String(limit), sort: 'relevance' }))
    if (!res.ok) throw new Error(`PubMed esearch HTTP ${res.status}`)
    const body = await res.json() as { esearchresult?: { idlist?: string[] } }
    const ids = body.esearchresult?.idlist ?? []
    return ids.length === 0 ? [] : this.summaries(ids)
  }

  async summaries(pmids: string[]): Promise<Article[]> {
    const res = await this.fetchImpl(this.url('esummary.fcgi', { db: 'pubmed', id: pmids.join(',') }))
    if (!res.ok) throw new Error(`PubMed esummary HTTP ${res.status}`)
    const body = await res.json() as { result?: Record<string, SummaryDoc | string[]> }
    const result = body.result ?? {}
    return pmids.flatMap(id => {
      const doc = result[id]
      return doc && !Array.isArray(doc) ? [toArticle(doc)] : []
    })
  }
}

function toArticle(d: SummaryDoc): Article {
  const doi = d.articleids?.find(x => x.idtype === 'doi')?.value ?? null
  return {
    pmid: d.uid,
    doi: doi ? doi.toLowerCase() : null,
    title: d.title ?? '',
    authors: (d.authors ?? []).map(a => a.name),
    journal: d.source ?? d.fulljournalname ?? '',
    year: (d.pubdate ?? '').slice(0, 4),
    ...(d.volume ? { volume: d.volume } : {}),
    ...(d.issue ? { issue: d.issue } : {}),
    ...(d.pages ? { pages: d.pages } : {}),
  }
}
