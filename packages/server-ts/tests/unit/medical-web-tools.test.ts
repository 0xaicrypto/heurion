import { describe, test, expect, vi, afterEach } from 'vitest'
import { SearchMedicalWebTool, FetchArticleSummaryTool, VisitMedicalSiteTool, ExtractFulltextTool } from '../../src/tools/medical-web-tools.js'
import { EventLog } from '../../src/core/event-log.js'

const SAMPLE_XML = `<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation>
<PMID>32500001</PMID>
<Article>
<Journal><Title>Journal of Clinical Oncology</Title><PubDate><Year>2020</Year></PubDate></Journal>
<ArticleTitle>Immune checkpoint inhibitors in EGFR-mutant NSCLC</ArticleTitle>
<Abstract><AbstractText>Background: real-world outcomes of ICIs in EGFR-mutant patients.</AbstractText></Abstract>
<AuthorList><Author><LastName>Zhao</LastName></Author><Author><LastName>Li</LastName></Author></AuthorList>
<ELocationID EIdType="doi">10.1200/JCO.19.01123</ELocationID>
</Article>
</MedlineCitation>
</PubmedArticle>
</PubmedArticleSet>`

const mockCtx = (): any => ({
  userId: 'user_1',
  sessionId: 'sess_1',
  eventLog: {
    append: vi.fn(),
  } as unknown as EventLog,
})

describe('medical web tools (#356)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('search_medical_web returns structured results', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const u = String(url)
      if (u.includes('esearch.fcgi')) {
        return { ok: true, text: async () => JSON.stringify({ esearchresult: { idlist: ['32500001', '32500002'] } }) } as any
      }
      return { ok: true, text: async () => SAMPLE_XML } as any
    })

    const ctx = mockCtx()
    const tool = new SearchMedicalWebTool(ctx)
    const res = await tool.execute({ query: 'EGFR NSCLC immunotherapy', limit: 2 })

    expect(res.success).toBe(true)
    expect(res.output).toContain('Immune checkpoint inhibitors in EGFR-mutant NSCLC')
    expect(res.output).toContain('PMID: 32500001')
    expect(res.output).toContain('Journal of Clinical Oncology')
    expect(res.output).toContain('DOI: 10.1200/JCO.19.01123')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // audit recorded
    expect(ctx.eventLog.append).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ action: 'medical_web_search' }) }))
  })

  test('search_medical_web handles empty results', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return { ok: true, text: async () => JSON.stringify({ esearchresult: { idlist: [] } }) } as any
    })
    const tool = new SearchMedicalWebTool(mockCtx())
    const res = await tool.execute({ query: 'zzz nothing here' })
    expect(res.success).toBe(true)
    expect(res.output).toContain('no results')
  })

  test('search_medical_web surfaces API errors without throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return { ok: false, status: 429 } as any
    })
    const tool = new SearchMedicalWebTool(mockCtx())
    const res = await tool.execute({ query: 'test' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('PubMed HTTP 429')
  })

  test('fetch_article_summary by PMID returns the abstract', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return { ok: true, text: async () => SAMPLE_XML } as any
    })
    const tool = new FetchArticleSummaryTool(mockCtx())
    const res = await tool.execute({ pmid: '32500001' })
    expect(res.success).toBe(true)
    expect(res.output).toContain('real-world outcomes of ICIs')
    expect(res.output).toContain('Zhao')
  })

  test('fetch_article_summary by DOI resolves via esearch first', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const u = String(url)
      if (u.includes('esearch.fcgi')) {
        return { ok: true, text: async () => JSON.stringify({ esearchresult: { idlist: ['32500001'] } }) } as any
      }
      return { ok: true, text: async () => SAMPLE_XML } as any
    })
    const tool = new FetchArticleSummaryTool(mockCtx())
    const res = await tool.execute({ doi: '10.1200/JCO.19.01123' })
    expect(res.success).toBe(true)
    expect(res.output).toContain('Immune checkpoint inhibitors')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('fetch_article_summary requires pmid or doi', async () => {
    const tool = new FetchArticleSummaryTool(mockCtx())
    const res = await tool.execute({})
    expect(res.success).toBe(false)
    expect(res.error).toContain('pmid or doi')
  })
})

describe('browser tools (#356 stage 2)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  test('visit_medical_site fetches rendered markdown via Browser Run', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'acct_1')
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'tok_1')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      json: async () => ({ markdown: '# Full Article\n\nThe content of the page.', title: 'Article Title' }),
    }) as any)

    const ctx = mockCtx()
    const tool = new VisitMedicalSiteTool(ctx)
    const res = await tool.execute({ url: 'https://pubmed.ncbi.nlm.nih.gov/32500001/' })

    expect(res.success).toBe(true)
    expect(res.output).toContain('Article Title')
    expect(res.output).toContain('Full Article')
    expect(String(fetchMock.mock.calls[0][0])).toContain('browser-run/markdown')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' })
    expect(ctx.eventLog.append).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ action: 'medical_web_visit' }) }))
  })

  test('browser tools degrade clearly when Cloudflare is not configured', async () => {
    vi.unstubAllEnvs()
    const tool = new VisitMedicalSiteTool(mockCtx())
    const res = await tool.execute({ url: 'https://example.com/' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('CLOUDFLARE_ACCOUNT_ID')

    const full = new ExtractFulltextTool(mockCtx())
    const res2 = await full.execute({ url: 'https://example.com/' })
    expect(res2.success).toBe(false)
  })

  test('extract_fulltext returns the page markdown', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'acct_1')
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'tok_1')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      json: async () => ({ markdown: 'Methods section text here' }),
    }) as any)
    const tool = new ExtractFulltextTool(mockCtx())
    const res = await tool.execute({ url: 'https://www.jto.org/article/xyz' })
    expect(res.success).toBe(true)
    expect(res.output).toContain('Methods section')
  })
})
