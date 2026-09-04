import { describe, test, expect } from 'vitest'
import {
  extractCitationMarkers,
  titlesFromCitationLabels,
  auditMemoryCitations,
} from '../../src/modules/knowledge/citation-audit.js'

/**
 * #839 缺口 2 — 记忆引用输出侧对账:
 * 输出中的 KB 引用(（来源：《标题》）)必须命中本轮注入集合,
 * 未命中降级"未溯源"标注,不静默。
 */

describe('extractCitationMarkers', () => {
  test('extracts canonical format with confidence', () => {
    const text = '结论如下（来源：《EGFR 管理指南》，置信度: 高），请参考。'
    const markers = extractCitationMarkers(text)
    expect(markers.length).toBe(1)
    expect(markers[0].title).toBe('EGFR 管理指南')
    expect(markers[0].confidence).toBe('高')
  })

  test('tolerates half-width parens/colon and missing confidence', () => {
    const text = '(来源:《PD-L1 解读》, 置信度: 中) 以及 (来源：《另一条》)'
    const markers = extractCitationMarkers(text)
    expect(markers.map((m) => m.title)).toEqual(['PD-L1 解读', '另一条'])
    expect(markers[1].confidence).toBeUndefined()
  })

  test('ignores non-KB citation styles (PMID/DOI/#807 scope)', () => {
    const text = '依据 (PMID: 12345678) 与 doi:10.1000/abc 的报道。'
    expect(extractCitationMarkers(text)).toEqual([])
  })
})

describe('titlesFromCitationLabels', () => {
  test('strips #756 label decorations', () => {
    const titles = titlesFromCitationLabels([
      '📖 EGFR 管理指南',
      '📄 患者报告.pdf',
      '📌 钉选总结',
      '🧠 相关事实',
    ])
    expect(titles).toEqual(['EGFR 管理指南', '患者报告.pdf', '钉选总结', '相关事实'])
  })
})

describe('auditMemoryCitations', () => {
  const injected = titlesFromCitationLabels(['📖 EGFR 管理指南', '📄 患者报告.pdf'])

  test('verified citations pass through untouched', () => {
    const text = 'A（来源：《EGFR 管理指南》，置信度: 高）B（来源：《egfr管理指南》）'
    const audit = auditMemoryCitations(text, injected)
    expect(audit.total).toBe(2)
    expect(audit.verified).toBe(2)
    expect(audit.unverified).toEqual([])
    expect(audit.annotatedText).toBe(text)
  })

  test('tolerates truncated/expanded titles via containment', () => {
    const text = '见（来源：《EGFR 管理指南（2024 修订版）》）'
    const audit = auditMemoryCitations(text, injected)
    expect(audit.verified).toBe(1)
    expect(audit.unverified).toEqual([])
  })

  test('hallucinated citations are downgraded to 未溯源 and confidence stripped', () => {
    const text = '结论（来源：《不存在的综述标题》，置信度: 高）如上。'
    const audit = auditMemoryCitations(text, injected)
    expect(audit.total).toBe(1)
    expect(audit.verified).toBe(0)
    expect(audit.unverified[0].title).toBe('不存在的综述标题')
    expect(audit.annotatedText).not.toBe(text)
    expect(audit.annotatedText).toContain('未溯源')
    expect(audit.annotatedText).not.toContain('置信度')
    expect(audit.annotatedText).toContain('《不存在的综述标题》')
  })

  test('mixed citations: only unmatched are annotated', () => {
    const text = '真（来源：《EGFR 管理指南》）与假（来源：《编造标题》）并存。'
    const audit = auditMemoryCitations(text, injected)
    expect(audit.total).toBe(2)
    expect(audit.verified).toBe(1)
    expect(audit.unverified.length).toBe(1)
    expect(audit.annotatedText).toContain('（来源：《EGFR 管理指南》）')
    expect(audit.annotatedText).toContain('《编造标题》，未溯源')
  })

  test('no markers → passthrough with zero counts', () => {
    const text = '普通回答,没有任何引用标注。'
    const audit = auditMemoryCitations(text, injected)
    expect(audit.total).toBe(0)
    expect(audit.annotatedText).toBe(text)
  })

  test('empty injection pool: every marker is unverified (nothing was injected)', () => {
    const text = '凭空引用（来源：《某标题》）'
    const audit = auditMemoryCitations(text, [])
    expect(audit.total).toBe(1)
    expect(audit.verified).toBe(0)
    expect(audit.annotatedText).toContain('未溯源')
  })
})
