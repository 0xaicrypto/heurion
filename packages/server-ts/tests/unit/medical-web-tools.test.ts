import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VisitMedicalSiteTool, clearBlockedHosts } from '../../src/tools/medical-web-tools.js'
import type { ToolContext } from '../../src/tools/tool-registry.js'
import { resetUrlCacheForTest } from '../../src/tools/url-cache/store.js'
import { setUrlDownloadTransportForTest, setUrlDownloadLookupForTest } from '../../src/lib/url-download.js'

/**
 * #835 — 站点反爬的优雅降级:
 * ① 直连抓取兜底(Browser Run 之前先试普通 HTTP + turndown);
 * ② 会话级 blocked-host 记忆(重复访问秒拒,不烧工具轮次);
 * ③ 失败信息带停止重试指引。
 *
 * P0 更新: 直连抓取已改走 @heurion/ssrf-guard（公网校验 + 钉定 DNS +
 * 流式大小上限）— 测试注入 guard 传输/解析钩子；global fetch 仅服务
 * Browser Run 路径（断言两者不再混用）。
 */

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'u_test',
    sessionId: 'session_test',
    eventLog: { append: vi.fn() },
    signal: undefined,
    ...overrides,
  } as unknown as ToolContext
}

const OK_HTML = `<html><head><title>ESMO Guidelines</title></head><body>
<main><h1>ESMO Clinical Practice Guidelines</h1>
<p>${'Clinical guidance for oncology practitioners. '.repeat(40)}</p></main>
</body></html>`

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
}

/** guard 直连传输 spy（默认回 OK_HTML）。 */
const directTransport = vi.fn(async () => htmlResponse(OK_HTML))
/** Browser Run 的 global fetch spy（不再承载直连）。 */
const browserFetch = vi.fn()

beforeEach(() => {
  clearBlockedHosts()
  directTransport.mockReset()
  directTransport.mockImplementation(async () => htmlResponse(OK_HTML))
  browserFetch.mockReset()
  process.env.URL_CACHE_DB_PATH = ':memory:'
  resetUrlCacheForTest()
  vi.stubGlobal('fetch', browserFetch)
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test_account')
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test_token')
  // 校验期 DNS 解析（guard 钉定）— 测试无外网。
  setUrlDownloadLookupForTest(async () => [{ address: '140.82.121.4' }])
  setUrlDownloadTransportForTest(directTransport)
})

afterEach(() => {
  setUrlDownloadTransportForTest(null)
  setUrlDownloadLookupForTest(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  clearBlockedHosts()
  delete process.env.URL_CACHE_DB_PATH
  resetUrlCacheForTest()
})

describe('visit_medical_site 反爬降级 (#835)', () => {
  it('direct fetch 命中:不调 Browser Run,返回 markdown', async () => {
    const tool = new VisitMedicalSiteTool(makeCtx())
    const result = await tool.execute({ url: 'https://www.example-guidelines.org/page' })
    expect(result.success).toBe(true)
    expect(String(result.output)).toContain('ESMO Clinical Practice Guidelines')
    expect(directTransport).toHaveBeenCalledTimes(1)
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it('两路皆空:报错含停止重试指引,同会话重复访问秒拒', async () => {
    // 直连:403;Browser Run:HTTP 200 但 markdown 为空(反爬站典型表现)。
    directTransport.mockResolvedValue(new Response('blocked', { status: 403 }))
    browserFetch.mockResolvedValue(new Response(JSON.stringify({ result: { markdown: '' } }), { status: 200 }))
    const tool = new VisitMedicalSiteTool(makeCtx())
    const first = await tool.execute({ url: 'https://protected-site.example.org/a' })
    expect(first.success).toBe(false)
    expect(String(first.error)).toContain('禁止自动化访问')
    expect(String(first.error)).toContain('请勿继续重试')

    // 同会话第二次访问:直接秒拒,不再发起任何网络请求。
    const directBefore = directTransport.mock.calls.length
    const browserBefore = browserFetch.mock.calls.length
    const second = await tool.execute({ url: 'https://protected-site.example.org/b' })
    expect(second.success).toBe(false)
    expect(String(second.error)).toContain('已在本会话确认为反爬拦截')
    expect(directTransport.mock.calls.length).toBe(directBefore)
    expect(browserFetch.mock.calls.length).toBe(browserBefore)
  })

  it('直连成功但内容过短(<300字):降级 Browser Run', async () => {
    directTransport.mockResolvedValue(htmlResponse('<html><body>ok</body></html>'))
    browserFetch.mockResolvedValue(new Response(JSON.stringify({ markdown: `# Real Content\n\n${'long enough body. '.repeat(60)}` }), { status: 200 }))
    const tool = new VisitMedicalSiteTool(makeCtx())
    const result = await tool.execute({ url: 'https://thin-site.example.org/x' })
    expect(result.success).toBe(true)
    expect(String(result.output)).toContain('Real Content')
    expect(directTransport).toHaveBeenCalledTimes(1)
    expect(browserFetch).toHaveBeenCalledTimes(1)
  })
})

// #861 — page_md 持久缓存: 第二次同 URL 零网络请求(跳过直连与 Browser Run)。
describe('page_md 缓存 (#861)', () => {
  it('第二次同 URL: 缓存命中,网络计数不再增长', async () => {
    const tool = new VisitMedicalSiteTool(makeCtx())
    const url = 'https://www.example-guidelines.org/cached-page'
    const r1 = await tool.execute({ url })
    expect(r1.success).toBe(true)
    expect(directTransport).toHaveBeenCalledTimes(1)
    const r2 = await tool.execute({ url })
    expect(r2.success).toBe(true)
    expect(String(r2.output)).toContain('ESMO Clinical Practice Guidelines')
    expect(directTransport).toHaveBeenCalledTimes(1) // 零网络
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it('direct+browser 全失败 + 有过期缓存 → 回退 stale 而非抛错', async () => {
    // 先写一条会过期(负 TTL)的缓存条目: 同 URL 走一次成功抓取再改写 TTL。
    const tool = new VisitMedicalSiteTool(makeCtx())
    const url = 'https://www.example-guidelines.org/stale-page'
    await tool.execute({ url })
    // 直接过期为该 URL 的条目(负 TTL 写入)
    const { cacheSet: rawSet } = await import('../../src/tools/url-cache/store.js')
    const { normalizeCacheKey } = await import('../../src/tools/url-cache/normalize.js')
    rawSet('page_md', normalizeCacheKey(url), 'ESMO Clinical Practice Guidelines(旧版快照)', -1)
    // 两路皆空: 直连 403,Browser Run 空 markdown
    directTransport.mockResolvedValue(new Response('blocked', { status: 403 }))
    browserFetch.mockResolvedValue(new Response(JSON.stringify({ result: { markdown: '' } }), { status: 200 }))
    const r = await tool.execute({ url })
    expect(r.success).toBe(true)
    expect(String(r.output)).toContain('ESMO Clinical Practice Guidelines')
  })
})
