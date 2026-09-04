import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeDoi,
  looksLikeDoi,
  crossrefResolveDoi,
  crossrefSearchBibliographic,
  formatCrossrefSummary,
} from '../../src/tools/crossref.client.js'
import { resetExternalFetchState } from '../../src/tools/external-fetch.js'

/**
 * #836 — Crossref client:DOI→规范 Citation(设计 L733 形状)/ 题名检索 /
 * DOI 归一化与校验。全部走 stub fetch,不发真实外呼。
 */

const WORK_OK = {
  message: {
    DOI: '10.1056/NEJMoa1709937',
    title: ['Durvalumab after chemoradiotherapy in stage III NSCLC'],
    author: [
      { family: 'Antonia', given: 'SJ' },
      { family: 'Villegas', given: 'A' },
      { family: 'Daniel', given: 'D' },
      { family: 'Vicente', given: 'D' },
    ],
    'container-title': ['New England Journal of Medicine'],
    issued: { 'date-parts': [[2017, 11, 16]] },
    volume: '377',
    page: '1919-1929',
    resource: { primary: { URL: 'https://www.nejm.org/doi/10.1056/NEJMoa1709937' } },
    abstract: '<jats:p>PACIFIC trial results…</jats:p>',
  },
}

describe('normalizeDoi / looksLikeDoi', () => {
  it('剥 URL 与 doi: 前缀', () => {
    expect(normalizeDoi('https://doi.org/10.1/abc')).toBe('10.1/abc')
    expect(normalizeDoi('http://dx.doi.org/10.1/abc')).toBe('10.1/abc')
    expect(normalizeDoi('doi: 10.1/abc')).toBe('10.1/abc')
    expect(normalizeDoi(' 10.1/abc ')).toBe('10.1/abc')
  })

  it('形状校验:合法 DOI 通过,裸词/PMID 拒绝', () => {
    expect(looksLikeDoi('10.1056/NEJMoa2004416')).toBe(true)
    expect(looksLikeDoi('https://doi.org/10.1056/x')).toBe(true)
    expect(looksLikeDoi('32500001')).toBe(false)
    expect(looksLikeDoi('not a doi')).toBe(false)
    expect(looksLikeDoi('')).toBe(false)
  })
})

describe('crossrefResolveDoi', () => {
  const fetchSpy = vi.fn()
  beforeEach(() => {
    resetExternalFetchState()
    fetchSpy.mockReset()
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    resetExternalFetchState()
  })

  it('DOI → 规范 Citation(L733 形状 + AMA 无 PMID)', async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify(WORK_OK), { status: 200 }))
    const r = await crossrefResolveDoi('https://doi.org/10.1056/NEJMoa1709937')
    expect(r).toBeTruthy()
    expect(r!.title).toContain('Durvalumab')
    expect(r!.journal).toBe('New England Journal of Medicine')
    expect(r!.year).toBe('2017')
    expect(r!.doi).toBe('10.1056/NEJMoa1709937')
    expect(r!.url).toContain('nejm.org')
    expect(r!.abstract).toBe('PACIFIC trial results…')
    expect(r!.ama).toContain('Antonia SJ, Villegas A, Daniel D, et al.')
    expect(r!.ama).toContain(' doi: 10.1056/NEJMoa1709937.')
    expect(r!.ama).not.toContain('PMID')
    expect(r!.ama).toContain('377:1919-1929')
  })

  it('DOI 不存在(404)→ null(业务分支,非错误)', async () => {
    fetchSpy.mockImplementation(async () => new Response('Not found', { status: 404 }))
    expect(await crossrefResolveDoi('10.9999/nonexistent')).toBeNull()
  })

  it('形式非法的 DOI 不发外呼直接返回 null', async () => {
    expect(await crossrefResolveDoi('hello world')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('同 DOI 第二次命中 24h 缓存,零外呼', async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify(WORK_OK), { status: 200 }))
    await crossrefResolveDoi('10.1056/NEJMoa1709937')
    await crossrefResolveDoi('10.1056/NEJMoa1709937')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('crossrefSearchBibliographic', () => {
  const fetchSpy = vi.fn()
  beforeEach(() => {
    resetExternalFetchState()
    fetchSpy.mockReset()
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    resetExternalFetchState()
  })

  it('题名检索 → Citation 列表,rows 夹取 1..8', async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({
      message: { items: [WORK_OK.message] },
    }), { status: 200 }))
    const list = await crossrefSearchBibliographic('Durvalumab stage III NSCLC', 5)
    expect(list.length).toBe(1)
    expect(list[0].doi).toBe('10.1056/NEJMoa1709937')
    const url = String(fetchSpy.mock.calls[0][0])
    expect(url).toContain('query.bibliographic=')
    expect(url).toContain('rows=5')
  })
})

describe('formatCrossrefSummary', () => {
  it('与 PubMed 输出形状对齐,摘要缺省时给出指引', () => {
    const r = {
      pmid: '',
      title: 'Durvalumab after chemoradiotherapy in stage III NSCLC',
      authors: ['Antonia SJ'],
      journal: 'New England Journal of Medicine',
      year: '2017',
      doi: '10.1056/NEJMoa1709937',
      ama: '',
    }
    const out = formatCrossrefSummary(r)
    expect(out).toContain('Title: Durvalumab')
    expect(out).toContain('DOI: 10.1056/NEJMoa1709937')
    expect(out).toContain('Source: Crossref')
    expect(out).toContain('pmid 走 PubMed')
  })
})
