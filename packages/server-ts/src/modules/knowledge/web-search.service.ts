/**
 * Web search providers for autonomous gap research.
 *
 * The default provider tries PubMed (free, no API key) first and falls back
 * to a safe placeholder when the network is unavailable. Future providers
 * (Google, Brave, SerpApi, internal KB, etc.) can be added by implementing
 * the same interface and registering them in createDefaultWebSearchProvider.
 */

export interface WebSearchProvider {
  readonly name: string
  search(query: string): Promise<string>
}

export class PlaceholderSearchProvider implements WebSearchProvider {
  readonly name = 'placeholder'

  async search(query: string): Promise<string> {
    return `External web search is not configured for this environment. ` +
      `The system would normally search authoritative sources for "${query}" ` +
      `and summarize the findings into a fact. Please configure a real search provider.`
  }
}

interface PubMedSearchResult {
  esearchresult?: {
    idlist?: string[]
  }
}

interface PubMedSummaryResult {
  result?: Record<string, {
    title?: string
    source?: string
    pubdate?: string
    uid?: string
  }>
}

export class PubMedSearchProvider implements WebSearchProvider {
  readonly name = 'pubmed'
  private baseUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'

  async search(query: string): Promise<string> {
    const term = encodeURIComponent(query)
    const searchUrl = `${this.baseUrl}/esearch.fcgi?db=pubmed&term=${term}&retmax=3&retmode=json`

    const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(8000) })
    if (!searchRes.ok) {
      throw new Error(`PubMed search failed: ${searchRes.status}`)
    }
    const searchData = (await searchRes.json()) as PubMedSearchResult
    const ids = searchData.esearchresult?.idlist || []
    if (ids.length === 0) {
      return `No PubMed articles found for "${query}".`
    }

    const summaryUrl = `${this.baseUrl}/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`
    const summaryRes = await fetch(summaryUrl, { signal: AbortSignal.timeout(8000) })
    if (!summaryRes.ok) {
      throw new Error(`PubMed summary failed: ${summaryRes.status}`)
    }
    const summaryData = (await summaryRes.json()) as PubMedSummaryResult
    const result = summaryData.result || {}

    const articles: string[] = []
    for (const id of ids) {
      const article = result[id]
      if (!article || !article.title) continue
      articles.push(
        `- ${article.title}${article.source ? ` (${article.source})` : ''}` +
        `\n  https://pubmed.ncbi.nlm.nih.gov/${article.uid || id}/`,
      )
    }

    if (articles.length === 0) {
      return `PubMed returned article IDs for "${query}" but no summaries were available.`
    }

    return `PubMed search results for "${query}":\n\n${articles.join('\n\n')}`
  }
}

export class CompositeWebSearchProvider implements WebSearchProvider {
  readonly name = 'composite'

  constructor(private providers: WebSearchProvider[]) {}

  async search(query: string): Promise<string> {
    const errors: string[] = []
    for (const provider of this.providers) {
      try {
        return await provider.search(query)
      } catch (err) {
        errors.push(`${provider.name}: ${(err as Error).message}`)
      }
    }
    return `Web search failed.\n\n${errors.join('\n')}`
  }
}

export function createDefaultWebSearchProvider(): WebSearchProvider {
  return new CompositeWebSearchProvider([
    new PubMedSearchProvider(),
    new PlaceholderSearchProvider(),
  ])
}
