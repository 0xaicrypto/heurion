import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { normalizeCacheKey } from '../../src/tools/url-cache/normalize.js'
import { cacheGet, cacheSet, resetUrlCacheForTest, rowCapFor } from '../../src/tools/url-cache/store.js'
import { externalRequest, resetExternalFetchState } from '../../src/tools/external-fetch.js'

/**
 * #857-862 — 外部内容本地缓存:归一化(#858)/SQLite 存储层(#859)/
 * externalRequest 两级缓存集成(#860)。测试用 :memory: 注入,零磁盘污染。
 */

beforeEach(() => {
  process.env.URL_CACHE_DB_PATH = ':memory:'
  process.env.URL_CACHE_ENABLED = 'true'
  delete process.env.CROSSREF_MAILTO
  resetExternalFetchState()
})
afterEach(() => {
  delete process.env.URL_CACHE_DB_PATH
  delete process.env.URL_CACHE_ENABLED
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetExternalFetchState()
})

describe('#858 normalizeCacheKey', () => {
  test('剔除鉴权参数(api_key/mailto/email) — env 变更不整批 miss', () => {
    const a = normalizeCacheKey('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=aspirin&api_key=SECRET')
    const b = normalizeCacheKey('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=aspirin')
    expect(a).toBe(b)
    expect(a).not.toContain('SECRET')
  })

  test('剔除追踪参数 + query 排序 + host 小写 + 去默认端口 + 去 fragment', () => {
    const a = normalizeCacheKey('https://API.Example.com:443/works?query=x&utm_source=s&rows=1#frag')
    const b = normalizeCacheKey('https://api.example.com/works?rows=1&query=x&fbclid=zz')
    expect(a).toBe(b)
    const c = normalizeCacheKey('http://api.example.com:80/works?rows=1&query=x')
    expect(c).toBe(normalizeCacheKey('http://api.example.com/works?query=x&rows=1'))
  })
})

describe('#859 store(:memory:)', () => {
  test('set/get 新鲜命中;TTL 过期 → stale 标记(不删除,转降级数据源)', () => {
    cacheSet('crossref', 'k1', 'body-1', 60_000)
    expect(cacheGet('crossref', 'k1')).toEqual({ body: 'body-1', stale: false })
    cacheSet('crossref', 'k2', 'old-body', -1) // 已过期
    const hit = cacheGet('crossref', 'k2')
    expect(hit?.body).toBe('old-body')
    expect(hit?.stale).toBe(true)
  })

  test('单条 >256KB 拒绝缓存(防御性)', () => {
    cacheSet('crossref', 'big', 'x'.repeat(300 * 1024), 60_000)
    expect(cacheGet('crossref', 'big')).toBeNull()
  })

  test('per-store 行数上限:page_md 2000 / 元数据 5000', () => {
    expect(rowCapFor('page_md')).toBe(2000)
    expect(rowCapFor('crossref')).toBe(5000)
  })

  test('corrupt db 文件 → 静默禁用(降级 miss,不弄坏请求)', () => {
    // 换一个坏文件路径 — ensureDb 打开失败 → cacheDisabled
    const prev = process.env.URL_CACHE_DB_PATH
    resetUrlCacheForTest()
    process.env.URL_CACHE_DB_PATH = '/proc/nonexistent-dir-fail/url_cache.db' // mkdir/write 必失败
    cacheSet('crossref', 'k', 'v', 1000)
    expect(cacheGet('crossref', 'k')).toBeNull()
    process.env.URL_CACHE_DB_PATH = prev
    resetUrlCacheForTest()
  })
})

describe('#860 externalRequest 两级缓存', () => {
  test('L2 新鲜命中(内存重置后仍命中 — 跨部署存活的核心语义)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const args = { query: 'aspirin', rows: '1' }
    const r1 = await externalRequest('crossref', '/works', args)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 只清内存(L1),L2 保留 → 第二次仍零上游
    resetExternalFetchState({ disk: false })
    const r2 = await externalRequest('crossref', '/works', args)
    expect(r2).toBe(r1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('stale-on-error: 上游最终失败(退避后仍 429) → 回退过期 L2 条目', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const args = { query: 'stale-test' }
    // call1: 真实成功 → L1+L2 各有一条
    const fetchOk = vi.fn(async () => new Response('"fresh"', { status: 200 }))
    vi.stubGlobal('fetch', fetchOk)
    await externalRequest('crossref', '/works', args)
    // 清内存(L1)保留 L2;把 L2 条目改写为已过期(负 TTL),正文换成旧版本
    resetExternalFetchState({ disk: false })
    const key = normalizeCacheKey('https://api.crossref.org/works?query=stale-test')
    cacheSet('crossref', key, '"stale-body"', -1)
    // call2: 上游退避重试后仍 429 → 走 stale-on-error 回退
    const fetchFail = vi.fn(async () => new Response('rate limited', { status: 429 }))
    vi.stubGlobal('fetch', fetchFail)
    const r = await externalRequest('crossref', '/works', args)
    expect(r).toBe('"stale-body"')
  })

  test('inflight 去重: 同 URL 并发只打一次上游', async () => {
    const fetchMock = vi.fn(async () => new Response('"ok"', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const args = { query: 'dedup' }
    const [a, b] = await Promise.all([
      externalRequest('crossref', '/works', args),
      externalRequest('crossref', '/works', args),
    ])
    expect(a).toBe(b)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('URL_CACHE_ENABLED=false → 全部直连(不读不写缓存)', async () => {
    process.env.URL_CACHE_ENABLED = 'false'
    const fetchMock = vi.fn(async () => new Response('"x"', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const args = { query: 'flag-off' }
    await externalRequest('crossref', '/works', args)
    await externalRequest('crossref', '/works', args)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('eutils TTL 5min → 6h(持久化后放宽,新会话命中)', async () => {
    const fetchMock = vi.fn(async () => new Response('<xml/>', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await externalRequest('eutils', 'esearch.fcgi', { db: 'pubmed', term: 'x' })
    await externalRequest('eutils', 'esearch.fcgi', { db: 'pubmed', term: 'x' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
