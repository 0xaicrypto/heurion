import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OaPdfLookupTool } from '../../src/tools/oa-pdf-tool.js'
import { resetExternalFetchState } from '../../src/tools/external-fetch.js'
import type { ToolContext } from '../../src/tools/tool-registry.js'

/**
 * #837 — oa_pdf_lookup:Unpaywall + Crossref combo。
 * OA → PDF URL;OA 无直链 → 落地页;非 OA → 出版社直链不绕付费墙;
 * DOI 恶意/非法输入防护;Unpaywall 失败 → Crossref 单独可用。
 */

function makeCtx(): ToolContext {
  return { userId: 'u_test', sessionId: 'session_test' } as unknown as ToolContext
}

describe('oa_pdf_lookup (#837)', () => {
  const fetchSpy = vi.fn()

  beforeEach(() => {
    resetExternalFetchState()
    fetchSpy.mockReset()
    vi.stubGlobal('fetch', fetchSpy)
    delete process.env.UNPAYWALL_EMAIL
    delete process.env.CROSSREF_MAILTO
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    resetExternalFetchState()
    delete process.env.UNPAYWALL_EMAIL
    delete process.env.CROSSREF_MAILTO
  })

  it('OA 命中:返回可下载 PDF URL + license', async () => {
    fetchSpy.mockImplementation(async (url) => {
      expect(String(url)).toContain('unpaywall')
      return new Response(JSON.stringify({
        is_oa: true,
        best_oa_location: { url_for_pdf: 'https://example.org/pacific.pdf', license: 'cc-by' },
      }), { status: 200 })
    })
    const res = await new OaPdfLookupTool(makeCtx()).execute({ doi: '10.1056/NEJMoa1709937' })
    expect(res.success).toBe(true)
    expect(String(res.output)).toContain('https://example.org/pacific.pdf')
    expect(String(res.output)).toContain('cc-by')
    expect(String(res.output)).toContain('import_reference')
  })

  it('OA 无直接 PDF:返回开放落地页', async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({
      is_oa: true,
      best_oa_location: { url: 'https://repository.example.org/handle/123' },
    }), { status: 200 }))
    const res = await new OaPdfLookupTool(makeCtx()).execute({ doi: '10.1234/oa-landing' })
    expect(res.success).toBe(true)
    expect(String(res.output)).toContain('repository.example.org')
  })

  it('非 OA:出版社直链 + 明示不绕付费墙', async () => {
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes('unpaywall')) {
        return new Response(JSON.stringify({ is_oa: false }), { status: 200 })
      }
      return new Response(JSON.stringify({
        message: { DOI: '10.1234/paywalled', title: ['Paywalled article'], resource: { primary: { URL: 'https://publisher.example.org/doi/10.1234/paywalled' } } },
      }), { status: 200 })
    })
    const res = await new OaPdfLookupTool(makeCtx()).execute({ doi: '10.1234/paywalled' })
    expect(res.success).toBe(true)
    expect(String(res.output)).toContain('publisher.example.org')
    expect(String(res.output)).toContain('institutional access')
    expect(String(res.output)).toContain('不绕过付费墙')
  })

  it('Unpaywall 挂掉 → Crossref 单独可用(combo 降级)', async () => {
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes('unpaywall')) {
        return new Response('upstream error', { status: 500 })
      }
      return new Response(JSON.stringify({
        message: { DOI: '10.1234/degraded', title: ['T'], resource: { primary: { URL: 'https://pub.example.org/x' } } },
      }), { status: 200 })
    })
    const res = await new OaPdfLookupTool(makeCtx()).execute({ doi: '10.1234/degraded' })
    expect(res.success).toBe(true)
    expect(String(res.output)).toContain('pub.example.org')
  })

  it('恶意/非法 DOI:防护拦截,不发外呼', async () => {
    const tool = new OaPdfLookupTool(makeCtx())
    for (const bad of ['', 'not-a-doi', '32500001', 'javascript:alert(1)', '../../../etc/passwd']) {
      const res = await tool.execute({ doi: bad })
      expect(res.success).toBe(false)
      expect(String(res.error)).toContain('DOI 形式不合法')
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('DOI 不存在(Crossref 404):如实报错指向 search_citation', async () => {
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes('unpaywall')) {
        return new Response('not found', { status: 404 })
      }
      return new Response('Not found', { status: 404 })
    })
    const res = await new OaPdfLookupTool(makeCtx()).execute({ doi: '10.9999/nope' })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('search_citation')
  })

  it('email 参数注入:UNPAYWALL_EMAIL 优先,缺省复用 CROSSREF_MAILTO', async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ is_oa: false }), { status: 200 }))
    process.env.CROSSREF_MAILTO = 'lab@example.org'
    await new OaPdfLookupTool(makeCtx()).execute({ doi: '10.1234/email-fallback' })
    expect(String(fetchSpy.mock.calls[0][0])).toContain('email=lab%40example.org')

    fetchSpy.mockClear()
    process.env.UNPAYWALL_EMAIL = 'up@example.org'
    await new OaPdfLookupTool(makeCtx()).execute({ doi: '10.1234/email-priority' })
    expect(String(fetchSpy.mock.calls[0][0])).toContain('email=up%40example.org')
  })
})
