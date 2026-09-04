import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  externalRequest,
  resetExternalFetchState,
} from '../../src/tools/external-fetch.js'
import { resetEutilsState, eutilsRequest } from '../../src/tools/search-citation-tool.js'

/**
 * #835 — 外部文献源统一请求管道(泛化 eutils 治理模式):
 * per-host 独立节流/缓存、24h TTL(D22)、429/5xx 退避、polite pool 注入。
 * 测试通过 stub global fetch + 重置钩子驱动,不发真实外呼。
 */

describe('external-fetch 统一管道 (#835)', () => {
  const fetchSpy = vi.fn()

  beforeEach(() => {
    resetExternalFetchState()
    fetchSpy.mockReset()
    vi.stubGlobal('fetch', fetchSpy)
    delete process.env.CROSSREF_MAILTO
    delete process.env.OPENALEX_MAILTO
    delete process.env.UNPAYWALL_EMAIL
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    resetExternalFetchState()
    delete process.env.CROSSREF_MAILTO
    delete process.env.OPENALEX_MAILTO
    delete process.env.UNPAYWALL_EMAIL
  })

  it('同一请求 24h 内命中缓存、零外呼', async () => {
    fetchSpy.mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }))
    const first = await externalRequest('crossref', '/works/10.1000/abc')
    const second = await externalRequest('crossref', '/works/10.1000/abc')
    expect(first).toBe('{"status":"ok"}')
    expect(second).toBe(first)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('不同参数不共享缓存', async () => {
    fetchSpy.mockImplementation(async () => new Response('x', { status: 200 }))
    await externalRequest('crossref', '/works/10.1000/abc')
    await externalRequest('crossref', '/works/10.1000/def')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('per-host 独立节流:A host 打满不拖慢 B host', async () => {
    fetchSpy.mockImplementation(async () => new Response('ok', { status: 200 }))
    // crossref 间隔 100ms:第一次记录时刻后,立即打 openalex(同 100ms 间隔但独立链)
    const t0 = Date.now()
    await externalRequest('crossref', '/works/a')
    await externalRequest('openalex', '/works?search=x')
    const elapsed = Date.now() - t0
    // 若两 host 共享节流阀,第二次请求会等 ≥100ms;独立时几乎立即
    expect(elapsed).toBeLessThan(90)
  })

  it('同 host 相邻请求保证最小间隔', async () => {
    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }))
    const stamps: number[] = []
    fetchSpy.mockImplementation(async () => {
      stamps.push(Date.now())
      return new Response('ok', { status: 200 })
    })
    await externalRequest('crossref', '/works/1')
    await externalRequest('crossref', '/works/2')
    expect(stamps.length).toBe(2)
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(90) // 100ms 间隔(留余量)
  })

  it('429 退避重试一次成功,Retry-After 生效', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    const t0 = Date.now()
    const body = await externalRequest('crossref', '/works/retry')
    expect(body).toBe('{"ok":true}')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1100) // backoffMs=1200 底线
  })

  it('持续 429:重试一次后抛错,错误带源名', async () => {
    fetchSpy.mockResolvedValue(new Response('slow down', { status: 429 }))
    await expect(externalRequest('openalex', '/works/x')).rejects.toThrow('OpenAlex HTTP 429')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('polite pool:CROSSREF_MAILTO/UNPAYWALL_EMAIL 注入对应参数', async () => {
    process.env.CROSSREF_MAILTO = 'lab@example.org'
    process.env.UNPAYWALL_EMAIL = 'lab@example.org'
    fetchSpy.mockImplementation(async () => new Response('{}', { status: 200 }))
    await externalRequest('crossref', '/works/10.1/x')
    await externalRequest('unpaywall', '/v2/10.1/x')
    const crossrefUrl = String(fetchSpy.mock.calls[0][0])
    const unpaywallUrl = String(fetchSpy.mock.calls[1][0])
    expect(crossrefUrl).toContain('mailto=lab%40example.org')
    expect(unpaywallUrl).toContain('email=lab%40example.org')
  })

  it('未知 host 报错', async () => {
    await expect(externalRequest('unknown-host', '/x')).rejects.toThrow('Unknown external host')
  })
})

describe('eutils 委托兼容 (#835 重构)', () => {
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

  it('eutilsRequest 走统一管道:缓存语义不变(5min TTL)', async () => {
    fetchSpy.mockResolvedValue(new Response('{"esearchresult":{"idlist":[]}}', { status: 200 }))
    await eutilsRequest('esearch.fcgi', { db: 'pubmed', term: 'x' })
    await eutilsRequest('esearch.fcgi', { db: 'pubmed', term: 'x' })
    expect(fetchSpy).toHaveBeenCalledTimes(1) // 缓存命中
  })

  it('resetEutilsState 清空统一管道状态', async () => {
    fetchSpy.mockImplementation(async () => new Response('{"ok":1}', { status: 200 }))
    await eutilsRequest('esearch.fcgi', { db: 'pubmed', term: 'reset-probe' })
    resetEutilsState()
    await eutilsRequest('esearch.fcgi', { db: 'pubmed', term: 'reset-probe' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
