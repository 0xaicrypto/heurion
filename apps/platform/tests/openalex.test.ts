import { describe, expect, it } from 'vitest'
import { OpenAlexClient } from '../src/literature/openalex.ts'

describe('OpenAlex 开放文献检索客户端（M3）', () => {
  it('正确解析 OpenAlex 作品数据为标准 Article', async () => {
    const mockResponse = {
      results: [
        {
          id: 'https://openalex.org/W1234567890',
          doi: 'https://doi.org/10.1038/s41586-023-00001-x',
          title: 'Deep learning for protein structure prediction',
          publication_year: 2023,
          authorships: [
            { author: { display_name: 'John Jumper' } },
            { author: { display_name: 'Demis Hassabis' } },
          ],
          primary_location: {
            source: {
              display_name: 'Nature',
            },
          },
          biblio: {
            volume: '615',
            issue: '7950',
            first_page: '120',
            last_page: '128',
          },
          ids: {
            pmid: 'https://pubmed.ncbi.nlm.nih.gov/37000000',
            doi: 'https://doi.org/10.1038/s41586-023-00001-x',
          },
        },
      ],
    }

    const client = new OpenAlexClient(async () => new Response(JSON.stringify(mockResponse), { status: 200 }))
    const results = await client.search('protein structure prediction', 5)

    expect(results).toHaveLength(1)
    const art = results[0]!
    expect(art.title).toBe('Deep learning for protein structure prediction')
    expect(art.doi).toBe('10.1038/s41586-023-00001-x')
    expect(art.pmid).toBe('37000000')
    expect(art.authors).toEqual(['John Jumper', 'Demis Hassabis'])
    expect(art.journal).toBe('Nature')
    expect(art.year).toBe('2023')
    expect(art.volume).toBe('615')
    expect(art.issue).toBe('7950')
    expect(art.pages).toBe('120-128')
  })

  it('空查询返回空数组，无网络请求', async () => {
    let called = false
    const client = new OpenAlexClient(async () => {
      called = true
      return new Response('{}', { status: 200 })
    })
    const res = await client.search('   ')
    expect(res).toEqual([])
    expect(called).toBe(false)
  })

  it('处理 HTTP 错误', async () => {
    const client = new OpenAlexClient(async () => new Response('Internal Server Error', { status: 500 }))
    await expect(client.search('cancer')).rejects.toThrow('OpenAlex HTTP 500')
  })

  it('MCP 工具 openalex_search 与 insert_citation 格式切换', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    const { buildMcpServer } = await import('../src/mcp/server.ts')
    const { TurnRegistry } = await import('../src/mcp/turns.ts')
    const { issueToken, verifyToken } = await import('../src/auth/token.ts')
    const { setup } = await import('./helpers.ts')

    const env = setup('# Title\n\nBody text.')
    const mockOpenAlex = new OpenAlexClient(async () => new Response(JSON.stringify({
      results: [{
        id: 'https://openalex.org/W1',
        doi: 'https://doi.org/10.1000/182',
        title: 'An important medical study',
        publication_year: 2024,
        authorships: [{ author: { display_name: 'Alice Smith' } }],
        primary_location: { source: { display_name: 'Lancet' } },
      }],
    }), { status: 200 }))

    const SECRET = 'test-secret'
    const token = issueToken(SECRET, { u: 'u1', d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 60 })
    const claims = verifyToken(SECRET, token, 'mcp')!

    const server = buildMcpServer({
      docs: env.docs,
      ops: env.ops,
      turns: new TurnRegistry(),
      pubmed: {} as any,
      claims: {} as any,
      renderer: {} as any,
      crossref: {
        lookup: async () => ({
          doi: '10.1000/182',
          pmid: '12345678',
          title: 'An important medical study',
          authors: ['Alice Smith', 'Bob Jones', 'Charlie Brown', 'David White'],
          journal: 'Lancet',
          year: '2024',
        }),
      } as any,
      openalex: mockOpenAlex,
      secret: SECRET,
      workspaceDir: () => '/tmp',
      isLiveSession: () => true,
    } as any, claims)

    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: 'test', version: '1.0' }, {})
    await client.connect(ct)

    // 测试 openalex_search
    const searchRes = await client.callTool({
      name: 'openalex_search',
      arguments: { query: 'important study', limit: 2 },
    }) as any
    const searchContent = JSON.parse(searchRes.content[0].text)
    expect(searchContent).toHaveLength(1)
    expect(searchContent[0].title).toBe('An important medical study')

    // 测试 insert_citation Vancouver 格式
    const citeRes = await client.callTool({
      name: 'insert_citation',
      arguments: { doc_id: env.docId, doi: '10.1000/182', style: 'vancouver' },
    }) as any
    const citeContent = JSON.parse(citeRes.content[0].text)
    expect(citeContent.cite_id).toBeTruthy()
    expect(citeContent.formatted).toContain('Lancet. 2024.')

    // 测试 insert_citation GB/T 7714 格式
    const citeResGb = await client.callTool({
      name: 'insert_citation',
      arguments: { doc_id: env.docId, doi: '10.1000/182', style: 'gbt7714' },
    }) as any
    const citeGbContent = JSON.parse(citeResGb.content[0].text)
    expect(citeGbContent.formatted).toContain('[J]. Lancet, 2024.')
  })
})

