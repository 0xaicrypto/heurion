import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchCitationTool, resetEutilsState } from '../../src/tools/search-citation-tool.js'
import type { ToolContext } from '../../src/tools/tool-registry.js'

/**
 * #835 — PubMed eutils 节流/缓存/重试:
 * 写作回合每轮并行 3 个查询曾把无 key 限速(3 req/s)打爆,连续 HTTP 429。
 * 修复:全局 400ms 节流阀 + 5 分钟响应缓存 + 429 退避重试一次 + 可选 NCBI_API_KEY。
 */

function makeCtx(): ToolContext {
  return { userId: 'u_test', sessionId: 'session_test' } as unknown as ToolContext
}

const ESEARCH_OK = JSON.stringify({ esearchresult: { idlist: ['111', '222'] } })
const ESUMMARY_OK = JSON.stringify({
  result: {
    111: { title: 'FLASH radiotherapy trial.', authors: [{ name: 'A' }], fulljournalname: 'Nature', pubdate: '2024 Jan', volume: '1', pages: '1-9', summaryids: [{ idtype: 'doi', value: '10.1/x' }] },
    222: { title: 'Carbon ion FLASH review.', authors: [{ name: 'B' }], fulljournalname: 'Radiother Oncol', pubdate: '2023 Mar', volume: '2', pages: '10-20', summaryids: [] },
  },
})

describe('search_citation 节流/缓存/重试 (#835)', () => {
  const fetchSpy = vi.fn()

  beforeEach(() => {
    resetEutilsState()
    fetchSpy.mockReset()
    vi.stubGlobal('fetch', fetchSpy)
    delete process.env.NCBI_API_KEY
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    resetEutilsState()
    delete process.env.NCBI_API_KEY
  })

  it('正常检索:esearch + esummary 各一次,输出 AMA 引用', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(ESEARCH_OK, { status: 200 }))
      .mockResolvedValueOnce(new Response(ESUMMARY_OK, { status: 200 }))
    const tool = new SearchCitationTool(makeCtx())
    const result = await tool.execute({ query: 'FLASH proton radiotherapy' })
    expect(result.success).toBe(true)
    expect(String(result.output)).toContain('PMID: 111')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('相同查询命中缓存:第二次零新增网络请求(含 #836 Crossref fallback)', async () => {
    // PubMed 无命中 → Crossref fallback 也发请求(esearch + crossref = 2 次),
    // 第二次执行时双源全部命中缓存,不再新增外呼。
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 }))
    const tool = new SearchCitationTool(makeCtx())
    const first = await tool.execute({ query: 'cache probe' })
    expect(first.success).toBe(false) // 双源无产出 → 如实报错
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const second = await tool.execute({ query: 'cache probe' })
    expect(second.success).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(2) // 双源缓存命中,零新增外呼
  })

  it('PubMed 无命中 → Crossref 补获(DOI 引用,无 PMID)', async () => {
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes('eutils')) {
        return new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 })
      }
      return new Response(JSON.stringify({
        message: {
          items: [{
            DOI: '10.1234/pre.2025',
            title: ['A preprint on FLASH radiotherapy'],
            author: [{ family: 'Wang', given: 'L' }, { family: 'Chen', given: 'X' }],
            'container-title': ['bioRxiv'],
            issued: { 'date-parts': [[2025]] },
          }],
        },
      }), { status: 200 })
    })
    const tool = new SearchCitationTool(makeCtx())
    const result = await tool.execute({ query: 'FLASH preprint' })
    expect(result.success).toBe(true)
    expect(String(result.output)).toContain('Crossref')
    expect(String(result.output)).toContain('doi: 10.1234/pre.2025.')
    // 引用行本身不带 PMID(Crossref 记录),仅文案里说明"记录无 PMID"
    expect(String(result.output).match(/^1\. .*PMID/m)).toBeNull()
  })

  it('双源均无命中:如实报错,零编造', async () => {
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes('eutils')) {
        return new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 })
      }
      return new Response(JSON.stringify({ message: { items: [] } }), { status: 200 })
    })
    const tool = new SearchCitationTool(makeCtx())
    const result = await tool.execute({ query: 'nothing exists' })
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('如实')
    expect(String(result.error)).toContain('禁止编造')
  })

  it('429 限流:退避后重试一次成功', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(new Response(ESEARCH_OK, { status: 200 }))
      .mockResolvedValueOnce(new Response(ESUMMARY_OK, { status: 200 }))
    const tool = new SearchCitationTool(makeCtx())
    const result = await tool.execute({ query: 'retry probe' })
    expect(result.success).toBe(true)
    expect(String(result.output)).toContain('PMID: 111')
    expect(fetchSpy).toHaveBeenCalledTimes(3) // 429 + 重试 esearch + esummary
  })

  it('持续 429:重试一次后如实报错,不编造', async () => {
    fetchSpy.mockResolvedValue(new Response('slow down', { status: 429 }))
    const tool = new SearchCitationTool(makeCtx())
    const result = await tool.execute({ query: 'still limited' })
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('429')
    expect(String(result.error)).toContain('如实告知')
  })

  it('配置 NCBI_API_KEY:请求自动附带 api_key 参数', async () => {
    process.env.NCBI_API_KEY = 'free_key_123'
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 }))
    const tool = new SearchCitationTool(makeCtx())
    await tool.execute({ query: 'key probe' })
    const calledUrl = String(fetchSpy.mock.calls[0][0])
    expect(calledUrl).toContain('api_key=free_key_123')
  })
})
