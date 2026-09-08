import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetExternalFetchState } from '../../src/tools/external-fetch.js'
import { fetchOpenAlexSource, fetchOpenAlexTypeDistribution } from '../../src/modules/submission/openalex.client.js'
import { fetchDoajJournal } from '../../src/modules/submission/doaj.client.js'
import { enrichJournal, enrichRecommendations } from '../../src/modules/submission/journal-enrich.js'
import { getJournalRepository, resetJournalRepository } from '../../src/modules/submission/journal-repository.js'
import { recommendTiers } from '../../src/modules/submission/selection-engine.js'
import type { Recommendation } from '../../src/modules/submission/journal-types.js'

/**
 * #852 — OpenAlex sources client / DOAJ client / monogram / 动态补充接线。
 * 通过 stub global fetch + resetExternalFetchState 驱动,不发真实外呼(#835 测试模式)。
 * 验收:OpenAlex 不可达时推荐全链不阻塞(seed 兜底)。
 */

const fetchSpy = vi.fn()

beforeEach(() => {
  resetExternalFetchState()
  fetchSpy.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
  delete process.env.OPENALEX_MAILTO
  delete process.env.JOURNAL_DYNAMIC_DATA
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetExternalFetchState()
  delete process.env.JOURNAL_DYNAMIC_DATA
})

const OPENALEX_SOURCE = {
  id: 'https://openalex.org/S123456',
  issn: ['1470-2045'],
  display_name: 'Lancet Oncology',
  works_count: 12000,
  cited_by_count: 700000,
  summary_stats: { h_index: 320, i10_index: 9000, '2yr_mean_citedness': 51.1 },
  is_oa: false,
  oa_works_count: 2400,
  topics: [
    { display_name: 'Oncology', count: 8000 },
    { display_name: 'Clinical Biochemistry', count: 2000 },
  ],
}

describe('OpenAlex client (#852)', () => {
  it('按 ISSN 解析 h-index/works_count/topics 占比', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(OPENALEX_SOURCE), { status: 200 }))
    const stats = await fetchOpenAlexSource('1470-2045')
    expect(stats).not.toBeNull()
    expect(stats!.openAlexId).toBe('S123456')
    expect(stats!.hIndex).toBe(320)
    expect(stats!.worksCount).toBe(12000)
    expect(stats!.oaRatio).toBeCloseTo(0.2, 5) // 2400/12000 真实 OA 占比
    expect(stats!.topics[0]).toMatchObject({ name: 'Oncology', share: 0.8 })
    expect(stats!.topics.reduce((s, t) => s + t.share, 0)).toBeCloseTo(1, 5)
  })

  it('近两年文章类型分布 group_by 解析(key 为 URI → 取尾 slug)', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      group_by: [
        { key: 'https://openalex.org/types/article', key_display_name: 'Article', count: 750 },
        { key: 'https://openalex.org/types/review', key_display_name: 'Review', count: 250 },
      ],
    }), { status: 200 }))
    const dist = await fetchOpenAlexTypeDistribution('S123456')
    expect(dist!.types[0]).toMatchObject({ type: 'article', share: 0.75 })
    expect(dist!.types[1].type).toBe('review')
    expect(dist!.types.reduce((s, t) => s + t.share, 0)).toBeCloseTo(1, 5)
  })

  it('无 ISSN → 刊名精确匹配兜底(display_name.search)', async () => {
    const stats = await (async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify({
        results: [{
          id: 'https://openalex.org/S999',
          display_name: 'BMC Cancer',
          works_count: 9000,
          summary_stats: { h_index: 120 },
          is_oa: true,
          oa_works_count: 8100,
          topics: [{ display_name: 'Oncology', count: 6000 }],
        }],
      }), { status: 200 }))
      const { fetchOpenAlexSource: byName } = await import('../../src/modules/submission/openalex.client.js')
      return byName(undefined, 'BMC Cancer')
    })()
    expect(stats!.openAlexId).toBe('S999')
    expect(stats!.oaRatio).toBeCloseTo(0.9, 5)
    // URLSearchParams 编码后 ':' → %3A、空格 → '+',filter 语义不变
    const calledUrl = String(fetchSpy.mock.calls[0][0])
    expect(calledUrl).toContain('display_name.search')
  })

  it('404(未收录)→ 抛错由上层兜底,enrichJournal 不阻塞', async () => {
    fetchSpy.mockResolvedValue(new Response('not found', { status: 404 }))
    const stats = await fetchOpenAlexSource('9999-9999').catch(() => null)
    expect(stats).toBeNull()
  })
})

describe('DOAJ client (#852)', () => {
  it('解析 APC 费用(max 数组,优先 USD 原币种)/许可 — 2026-09 实测结构', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      results: [{ bibjson: {
        title: 'BMC Cancer',
        apc: { has_apc: true, max: [{ price: 3150, currency: 'EUR' }, { price: 3550, currency: 'USD' }, { price: 2690, currency: 'GBP' }] },
        license: [{ type: 'CC BY' }],
      } }],
    }), { status: 200 }))
    const info = await fetchDoajJournal('1471-2407')
    expect(info.inDoaj).toBe(true)
    expect(info.apc).toEqual({ value: 3550, currency: 'USD' })
    expect(info.license).toBe('CC BY')
  })

  it('旧版 average_price 字段兼容解析', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      results: [{ bibjson: { title: 'x', apc: { currency: 'EUR', average_price: 2500 } } }],
    }), { status: 200 }))
    const info = await fetchDoajJournal('0000-0001')
    expect(info.apc).toEqual({ value: 2500, currency: 'EUR' })
  })

  it('未收录 → inDoaj:false', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }))
    const info = await fetchDoajJournal('0000-0000')
    expect(info.inDoaj).toBe(false)
  })
})

describe('动态补充接线(失败回落 seed)', () => {
  it('网络全挂 → enrichJournal 原样返回 seed 值,推荐链不阻塞(含无 ISSN 刊)', async () => {
    resetJournalRepository()
    fetchSpy.mockRejectedValue(new Error('network down'))
    const seed = getJournalRepository().get('bmc-cancer')!
    const enriched = await enrichJournal(seed)
    expect(enriched.metrics.impactFactor?.value).toBe(3.4)
    expect(enriched.metrics.apc).toMatchObject({ value: 2790, source: 'doaj_snapshot' })
    expect(enriched.metrics.openAlex).toBeUndefined()
  })

  it('无 ISSN 刊 → 刊名兜底查找 + DOAJ 跳过(seed APC 保留快照)', async () => {
    resetJournalRepository()
    fetchSpy.mockImplementation(async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/sources?') && u.includes('display_name.search')) {
        return new Response(JSON.stringify({
          results: [{
            id: 'https://openalex.org/S999',
            display_name: 'BMC Cancer',
            works_count: 9000,
            summary_stats: { h_index: 120 },
            is_oa: true,
            oa_works_count: 8100,
            topics: [{ display_name: 'Oncology', count: 6000 }],
          }],
        }), { status: 200 })
      }
      if (u.includes('group_by=type')) {
        return new Response(JSON.stringify({ group_by: [{ key: 'https://openalex.org/types/article', count: 850 }, { key: 'https://openalex.org/types/case-report', count: 150 }] }), { status: 200 })
      }
      if (u.startsWith('https://doaj.org/')) {
        throw new Error('DOAJ should not be called for ISSN-less journal')
      }
      return new Response('unexpected', { status: 500 })
    })
    const seed = getJournalRepository().get('bmc-cancer')!
    const enriched = await enrichJournal(seed)
    expect(enriched.metrics.openAlex).toMatchObject({ hIndex: 120, source: 'openalex' })
    expect(enriched.metrics.openAlex?.oaRatio).toBeCloseTo(0.9, 5)
    expect(enriched.metrics.articleTypeDistribution?.value[0]).toEqual({ type: 'article', share: 0.85 })
    expect(enriched.metrics.apc).toMatchObject({ value: 2790, source: 'doaj_snapshot' }) // seed 保留
  })

  it('动态成功 → metrics 覆盖为 openalex/doaj 来源 + asOf', async () => {
    resetJournalRepository()
    fetchSpy.mockImplementation(async (url: string | URL) => {
      const u = String(url)
      if (u.startsWith('https://api.openalex.org/sources/')) {
        return new Response(JSON.stringify(OPENALEX_SOURCE), { status: 200 })
      }
      if (u.includes('group_by=type')) {
        return new Response(JSON.stringify({ group_by: [{ key: 'article', count: 900 }, { key: 'review', count: 100 }] }), { status: 200 })
      }
      if (u.startsWith('https://doaj.org/')) {
        return new Response(JSON.stringify({ results: [{ bibjson: { title: 'x', apc: { currency: 'EUR', average_price: 2500 } } }] }), { status: 200 })
      }
      return new Response('unexpected', { status: 500 })
    })
    const seed = getJournalRepository().get('lancet-oncol')!
    const enriched = await enrichJournal(seed)
    expect(enriched.metrics.openAlex).toMatchObject({ hIndex: 320, source: 'openalex' })
    expect(enriched.metrics.articleTypeDistribution?.source).toBe('openalex')
    expect(enriched.metrics.articleTypeDistribution?.value[0]).toEqual({ type: 'article', share: 0.9 })
    expect(enriched.metrics.apc).toMatchObject({ value: 2500, currency: 'EUR', source: 'doaj' })
    // seed 原对象不被污染
    expect(getJournalRepository().get('lancet-oncol')!.metrics.apc?.value).toBeUndefined()
  })

  it('同类文章:search + source 过滤 → 结构化结果;标题提取检索词', async () => {
    const { fetchOpenAlexSimilarWorks, extractSearchTerms } = await import('../../src/modules/submission/openalex.client.js')
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      results: [
        { id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1000/abc', display_name: 'Neoadjuvant chemo in NSCLC', publication_year: 2025, cited_by_count: 12 },
        { id: 'https://openalex.org/W2', doi: null, display_name: 'EGFR survival cohort', publication_year: 2024, cited_by_count: 3 },
      ],
    }), { status: 200 }))
    const works = await fetchOpenAlexSimilarWorks('S123456', 'Neoadjuvant immunotherapy efficacy in resectable NSCLC patients')
    expect(works).toHaveLength(2)
    expect(works[0]).toMatchObject({ title: 'Neoadjuvant chemo in NSCLC', year: 2025, doi: '10.1000/abc', citedBy: 12 })
    // 检索词:去标点 + 去单字符词 + 截断到 10 词
    expect(extractSearchTerms('Efficacy of "neoadjuvant" therapy: a cohort study (n=320)')).toBe('Efficacy of neoadjuvant therapy cohort study n=320')
  })

  it('端到端:enrichJournal(similarTo) 挂载 similarWorks;无命中不挂载', async () => {
    resetJournalRepository()
    fetchSpy.mockImplementation(async (url: string | URL) => {
      const u = String(url)
      if (u.startsWith('https://api.openalex.org/sources/')) {
        return new Response(JSON.stringify({ ...OPENALEX_SOURCE, id: 'https://openalex.org/S777' }), { status: 200 })
      }
      if (u.includes('group_by=type')) {
        return new Response(JSON.stringify({ group_by: [{ key: 'https://openalex.org/types/article', count: 100 }] }), { status: 200 })
      }
      if (u.includes('/works?') && u.includes('search=')) {
        return new Response(JSON.stringify({ results: [{ id: 'https://openalex.org/W9', display_name: 'Similar prior work', publication_year: 2025 }] }), { status: 200 })
      }
      if (u.startsWith('https://doaj.org/')) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 })
      }
      return new Response('unexpected', { status: 500 })
    })
    const seed = getJournalRepository().get('lancet-oncol')!
    const enriched = await enrichJournal(seed, 'Immunotherapy in lung cancer')
    expect(enriched.similarWorks).toEqual([{ openAlexId: 'W9', title: 'Similar prior work', year: 2025, doi: undefined, citedBy: undefined }])
  })

  it('端到端:recommendTiers → enrichRecommendations 在外呼全挂时仍返回三档', async () => {
    resetJournalRepository()
    fetchSpy.mockRejectedValue(new Error('network down'))
    const result = recommendTiers({
      title: 'Efficacy of immunotherapy in NSCLC',
      abstract: 'lung cancer cohort study',
    })
    const enriched: Recommendation[] = await enrichRecommendations(result.tiers.match)
    expect(enriched.length).toBeGreaterThan(0)
    expect(enriched[0].breakdown.some((b) => b.dimension === 'scope')).toBe(true)
  })
})

describe('ISSN monogram (D6)', () => {
  it('首字母字标 + 确定性取色,零版权风险', async () => {
    const { buildMonogram } = await import('../../src/modules/submission/journal-monogram.js')
    expect(buildMonogram('Journal of Clinical Oncology').monogram).toBe('CO')
    expect(buildMonogram('New England Journal of Medicine').monogram).toBe('NE')
    expect(buildMonogram('The Lancet').monogram).toBe('LA')
    expect(buildMonogram('中华医学杂志').monogram).toBe('中')
    const a = buildMonogram('Lancet Oncology')
    const b = buildMonogram('Lancet Oncology')
    expect(a).toEqual(b)
    expect(a.color).toMatch(/^#[0-9a-f]{6}$/)
  })
})
