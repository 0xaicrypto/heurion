import { describe, expect, it } from 'vitest'
import { fetchGuideForAuthors, precheckAgainstGuide, resetGuideCache } from '../../src/modules/submission/guide-for-authors.js'
import { getJournalRepository, resetJournalRepository } from '../../src/modules/submission/journal-repository.js'
import type { GuideRequirements, JournalRecord } from '../../src/modules/submission/journal-types.js'

/**
 * #851 — Guide for Authors 抓取校验 + 投稿前检查单。
 * 验收:至少字数/引用格式两项可自动判定;抓取失败降级路径有测试。
 */

function req(overrides: Partial<GuideRequirements> = {}): GuideRequirements {
  return {
    journalId: 'jco',
    journalName: 'Journal of Clinical Oncology',
    bodyWordLimit: 4000,
    abstractWordLimit: 350,
    abstractStructure: 'IMRaD',
    figureLimit: 8,
    referenceStyle: 'AMA',
    requiredStatements: ['ethics', 'conflict'],
    confidence: 'high',
    sourceUrl: 'https://example.com/guide',
    fetchedAt: '2026-09-08T00:00:00.000Z',
    ...overrides,
  }
}

const SAMPLE_DOC = `# 阿法替尼治疗 NSCLC 的真实世界研究

## Abstract

**Background**EGFR 突变非小细胞肺癌的治疗选择有限。**Methods**回顾性纳入 320 例患者。**Results**中位 PFS 为 13.2 个月。**Conclusions**阿法替尼疗效确切。

## Introduction

肺靶向治疗进展迅速[1]。联合化疗获益[2]。

## Methods

经 IRB 批准,回顾性收集 2020-2024 年数据[3]。

## Results

见图1 ![生存曲线](fig1.png) 与 ![瀑布图](fig2.png)。这与既往研究一致[4]。

## Discussion

与文献[5]结论相同。

## References

[1] something. [2] another.`
const SHORT_DOC = '# 标题\n\n## Abstract\n\n背景/方法/结果/结论。正文只有很少的内容。'
const APA_DOC = '# 标题\n\n## Abstract\n\nThis study confirms previous findings with an abstract that is far longer than ten words.\n\n本研究支持既往结论 (Zhang, 2023)。'

describe('precheckAgainstGuide (#851)', () => {
  it('字数/引用格式/图表/声明逐项可自动判定', () => {
    const items = precheckAgainstGuide(req(), SAMPLE_DOC)
    const byId = Object.fromEntries(items.map((i) => [i.id, i]))
    // 字数:约 120 词 << 4000 → 通过
    expect(byId.word_limit.ok).toBe(true)
    // 引用格式:编号制 [1] vs 目标刊 AMA(编号制)→ 通过
    expect(byId.reference_style.ok).toBe(true)
    // 图表:2 ≤ 8 → 通过
    expect(byId.figure_limit.ok).toBe(true)
    // 声明:文档含 IRB → ethics 通过;无利益冲突声明 → 不通过
    expect(byId.stmt_ethics.ok).toBe(true)
    expect(byId.stmt_conflict.ok).toBe(false)
    expect(items.every((i) => i.ok !== null)).toBe(true)
  })

  it('摘要字数超限 + 作者年份引用 vs 编制制目标刊 → 不通过', () => {
    const items = precheckAgainstGuide(req({ abstractWordLimit: 10 }), APA_DOC)
    const byId = Object.fromEntries(items.map((i) => [i.id, i]))
    expect(byId.abstract_limit.ok).toBe(false)
    expect(byId.reference_style.ok).toBe(false)
    expect(byId.reference_style.detail).toContain('作者-年份')
  })

  it('无 requirements → 全部转人工,不编造结果', () => {
    const items = precheckAgainstGuide(null, SAMPLE_DOC)
    expect(items).toHaveLength(1)
    expect(items[0].ok).toBeNull()
  })

  it('confidence 非 high → 附加人工复核项', () => {
    const items = precheckAgainstGuide(req({ confidence: 'medium' }), SAMPLE_DOC)
    expect(items.some((i) => i.id === 'manual_review')).toBe(true)
  })
})

describe('fetchGuideForAuthors 降级路径 (#851)', () => {
  it('无 guideUrl → ok:false + 人工核对链接', async () => {
    resetGuideCache()
    resetJournalRepository()
    const journal = getJournalRepository().get('jto')! // 未配 guideUrl
    const result = await fetchGuideForAuthors(journal)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('人工核对')
      expect(result.manualUrl).toContain('google.com')
    }
  })

  it('抓取失败(HTTP 500)→ ok:false,不阻塞不抛错', async () => {
    resetGuideCache()
    resetJournalRepository()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('blocked', { status: 500 })) as typeof fetch
    try {
      const journal = getJournalRepository().get('nejm')! // 有 guideUrl
      const result = await fetchGuideForAuthors(journal)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('抓取失败')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('无 LLM key(测试环境)→ 抓取成功但抽取失败 → ok:false 降级', async () => {
    resetGuideCache()
    resetJournalRepository()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(
      `<html><body><p>Manuscripts should not exceed 4000 words. Figures are limited to 8. References follow AMA style.</p>${'<p>filler text for length check </p>'.repeat(30)}</body></html>`,
      { status: 200 },
    )) as typeof fetch
    try {
      const journal = getJournalRepository().get('nejm')!
      const result = await fetchGuideForAuthors(journal)
      // 测试环境无 API key → 抽取层返回 null → 降级(诚实,不编造要求)
      expect(result.ok).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('24h 缓存命中:第二次同刊不再发请求', async () => {
    resetGuideCache()
    resetJournalRepository()
    let calls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { calls += 1; return new Response('x', { status: 500 }) }) as typeof fetch
    try {
      const journal = getJournalRepository().get('nejm')!
      await fetchGuideForAuthors(journal)
      await fetchGuideForAuthors(journal)
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('JournalRecord 契约完整性', () => {
  it('guideUrl 仅在可信来源上配置', () => {
    resetJournalRepository()
    const withGuide = getJournalRepository().listAll().filter((j: JournalRecord) => j.guideUrl)
    expect(withGuide.length).toBeGreaterThan(5)
    for (const j of withGuide) {
      expect(j.guideUrl!.startsWith('https://')).toBe(true)
    }
  })
})
