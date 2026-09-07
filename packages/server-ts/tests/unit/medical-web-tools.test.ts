import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VisitMedicalSiteTool, clearBlockedHosts } from '../../src/tools/medical-web-tools.js'
import type { ToolContext } from '../../src/tools/tool-registry.js'
import { resetUrlCacheForTest } from '../../src/tools/url-cache/store.js'

/**
 * #835 — 站点反爬的优雅降级:
 * ① 直连抓取兜底(Browser Run 之前先试普通 HTTP + turndown);
 * ② 会话级 blocked-host 记忆(重复访问秒拒,不烧工具轮次);
 * ③ 失败信息带停止重试指引。
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

describe('visit_medical_site 反爬降级 (#835)', () => {
  const fetchSpy = vi.fn()

  beforeEach(() => {
    clearBlockedHosts()
    fetchSpy.mockReset()
    process.env.URL_CACHE_DB_PATH = ':memory:'
    resetUrlCacheForTest()
    vi.stubGlobal('fetch', fetchSpy)
    // Browser Run 路径需要账号配置(直连兜底不受影响)。
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test_account')
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test_token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    clearBlockedHosts()
    delete process.env.URL_CACHE_DB_PATH
    resetUrlCacheForTest()
  })

  it('direct fetch 命中:不调 Browser Run,返回 markdown', async () => {
    // fetch 同时服务直连抓取与 Browser Run — 这里只应发生 1 次(直连)。
    fetchSpy.mockResolvedValue(new Response(OK_HTML, { status: 200, headers: { 'content-type': 'text/html' } }))
    const tool = new VisitMedicalSiteTool(makeCtx())
    const result = await tool.execute({ url: 'https://www.example-guidelines.org/page' })
    expect(result.success).toBe(true)
    expect(String(result.output)).toContain('ESMO Clinical Practice Guidelines')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('两路皆空:报错含停止重试指引,同会话重复访问秒拒', async () => {
    // 直连:403;Browser Run:HTTP 200 但 markdown 为空(反爬站典型表现)。
    fetchSpy
      .mockResolvedValueOnce(new Response('blocked', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { markdown: '' } }), { status: 200 }))
    const tool = new VisitMedicalSiteTool(makeCtx())
    const first = await tool.execute({ url: 'https://protected-site.example.org/a' })
    expect(first.success).toBe(false)
    expect(String(first.error)).toContain('禁止自动化访问')
    expect(String(first.error)).toContain('请勿继续重试')

    // 同会话第二次访问:直接秒拒,不再发起任何网络请求。
    const before = fetchSpy.mock.calls.length
    const second = await tool.execute({ url: 'https://protected-site.example.org/b' })
    expect(second.success).toBe(false)
    expect(String(second.error)).toContain('已在本会话确认为反爬拦截')
    expect(fetchSpy.mock.calls.length).toBe(before)
  })

  it('直连成功但内容过短(<300字):降级 Browser Run', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('<html><body>ok</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ markdown: `# Real Content\n\n${'long enough body. '.repeat(60)}` }), { status: 200 }))
    const tool = new VisitMedicalSiteTool(makeCtx())
    const result = await tool.execute({ url: 'https://thin-site.example.org/x' })
    expect(result.success).toBe(true)
    expect(String(result.output)).toContain('Real Content')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

// #861 — page_md 持久缓存: 第二次同 URL 零网络请求(跳过直连与 Browser Run)。
describe('page_md 缓存 (#861)', () => {
  const fetchSpy = vi.fn()
  beforeEach(() => {
    clearBlockedHosts()
    fetchSpy.mockReset()
    process.env.URL_CACHE_DB_PATH = ':memory:'
    resetUrlCacheForTest()
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test_account')
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test_token')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    clearBlockedHosts()
    delete process.env.URL_CACHE_DB_PATH
    resetUrlCacheForTest()
  })

  it('第二次同 URL: 缓存命中,fetch 计数不再增长', async () => {
    fetchSpy.mockResolvedValue(new Response(OK_HTML, { status: 200, headers: { 'content-type': 'text/html' } }))
    const tool = new VisitMedicalSiteTool(makeCtx())
    const url = 'https://www.example-guidelines.org/cached-page'
    const r1 = await tool.execute({ url })
    expect(r1.success).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const r2 = await tool.execute({ url })
    expect(r2.success).toBe(true)
    expect(String(r2.output)).toContain('ESMO Clinical Practice Guidelines')
    expect(fetchSpy).toHaveBeenCalledTimes(1) // 零网络
  })

  it('direct+browser 全失败 + 有过期缓存 → 回退 stale 而非抛错', async () => {
    // 先写一条会过期(负 TTL)的缓存条目: 同 URL 走一次成功抓取再改写 TTL。
    fetchSpy.mockResolvedValue(new Response(OK_HTML, { status: 200, headers: { 'content-type': 'text/html' } }))
    const tool = new VisitMedicalSiteTool(makeCtx())
    const url = 'https://www.example-guidelines.org/stale-page'
    await tool.execute({ url })
    // 直接过期为该 URL 的条目(负 TTL 写入)
    const { cacheSet: rawSet } = await import('../../src/tools/url-cache/store.js')
    const { normalizeCacheKey } = await import('../../src/tools/url-cache/normalize.js')
    rawSet('page_md', normalizeCacheKey(url), 'ESMO Clinical Practice Guidelines(旧版快照)', -1)
    // 两路皆空: 直连 403,Browser Run 空 markdown
    fetchSpy
      .mockResolvedValueOnce(new Response('blocked', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { markdown: '' } }), { status: 200 }))
    const r = await tool.execute({ url })
    expect(r.success).toBe(true)
    expect(String(r.output)).toContain('ESMO Clinical Practice Guidelines')
  })
})
