import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetExternalFetchState } from '../../src/tools/external-fetch.js'
import { SearchOpenAlexTool } from '../../src/tools/openalex-search-tool.js'

/** search_openalex — OpenAlex 学术检索工具(方案2)。外呼经 #835 管道,测试 stub fetch。 */

function makeCtx(): unknown {
  return { userId: 'u_test', sessionId: 'session_test', eventLog: { append: vi.fn() } }
}

const WORKS_RESPONSE = {
  meta: { count: 42 },
  results: [
    {
      id: 'https://openalex.org/W1',
      doi: 'https://doi.org/10.1000/x',
      display_name: 'Immunotherapy outcomes in NSCLC',
      publication_year: 2025,
      cited_by_count: 88,
      type: 'article',
      open_access: { is_oa: true, oa_status: 'gold' },
      primary_location: { source: { display_name: 'Lancet Oncology' } },
      authorships: [{ author: { display_name: 'Zhang S' } }, { author: { display_name: 'Li W' } }],
    },
  ],
}

describe('search_openalex tool', () => {
  const fetchSpy = vi.fn()
  let tool: SearchOpenAlexTool

  beforeEach(() => {
    resetExternalFetchState()
    fetchSpy.mockReset()
    vi.stubGlobal('fetch', fetchSpy)
    delete process.env.OPENALEX_MAILTO
    tool = new SearchOpenAlexTool(makeCtx())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    resetExternalFetchState()
  })

  it('定义暴露 name/parameters,query 必填', async () => {
    expect(tool.name).toBe('search_openalex')
    expect(tool.parameters.required).toEqual(['query'])
    expect(await tool.execute({ query: '' })).toMatchObject({ success: false })
  })

  it('检索结果格式化:标题/年份/期刊/引用量/OA/DOI', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(WORKS_RESPONSE), { status: 200 }))
    const res = await tool.execute({ query: 'immunotherapy NSCLC' })
    expect(res.success).toBe(true)
    expect(res.output).toContain('Immunotherapy outcomes in NSCLC')
    expect(res.output).toContain('Zhang S et al.')
    expect(res.output).toContain('Lancet Oncology')
    expect(res.output).toContain('cited_by 88')
    expect(res.output).toContain('OA(gold)')
    expect(res.output).toContain('10.1000/x')
    const url = String(fetchSpy.mock.calls[0][0])
    expect(url).toContain('search=immunotherapy')
  })

  it('过滤器:年份区间 + OA + source_name 先解析 source id', async () => {
    fetchSpy.mockImplementation(async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/sources?')) {
        return new Response(JSON.stringify({ results: [{ id: 'https://openalex.org/S123', display_name: 'Lancet Oncology' }] }), { status: 200 })
      }
      return new Response(JSON.stringify(WORKS_RESPONSE), { status: 200 })
    })
    const res = await tool.execute({ query: 'x', from_year: 2023, to_year: 2026, open_access_only: true, source_name: 'Lancet Oncology' })
    expect(res.success).toBe(true)
    const url = decodeURIComponent(String(fetchSpy.mock.calls[1][0]))
    expect(url).toContain('publication_year:2023-2026')
    expect(url).toContain('is_oa:true')
    expect(url).toContain('primary_location.source.id:S123')
  })

  it('sort_by_citations 与空结果分支', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ meta: { count: 0 }, results: [] }), { status: 200 }))
    const empty = await tool.execute({ query: 'obsure topic xyz', sort_by_citations: true })
    expect(empty.success).toBe(true)
    expect(String(empty.output)).toContain('no works matched')
    const url = String(fetchSpy.mock.calls[0][0])
    expect(url).toContain('sort=cited_by_count%3Adesc')
  })

  it('上游失败 → success:false 结构化错误', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'))
    const res = await tool.execute({ query: 'anything' })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('search_openalex failed')
  })
})
