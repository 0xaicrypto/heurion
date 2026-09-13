import { describe, test, expect } from 'vitest'
import { textSimilarity, closestTextCandidates, formatAnchorCandidates, describeSectionList } from '../../src/tools/anchor-diagnostics.js'
import { buildBlockProjection } from '../../src/lib/block-projection.js'

/** #1020/#1022 — 锚点失败结构化诊断（纯函数）。 */
const BODY = [
  '# Paper',
  '',
  '## Introduction',
  'intro body text.',
  '',
  '## Methods',
  'methods body text.',
  '',
  'second methods line.',
].join('\n')

describe('#1022 anchor-diagnostics', () => {
  test('textSimilarity:相同=1,无关低,细微差异高', () => {
    expect(textSimilarity('hello world', 'hello world')).toBe(1)
    expect(textSimilarity('hello world', 'completely different words')).toBeLessThan(0.3)
    expect(textSimilarity('methods body text.', 'methods body texts.')).toBeGreaterThan(0.9)
  })

  test('closestTextCandidates:返回最接近候选 + 章节归属', () => {
    const cands = closestTextCandidates(BODY, 'intro body txt.')
    expect(cands.length).toBeGreaterThan(0)
    expect(cands[0].text).toContain('intro body text.')
    expect(cands[0].heading).toBe('Introduction')
    expect(cands[0].similarity).toBeGreaterThan(0.8)
  })

  test('closestTextCandidates:within 限定只看节内,不返回节外候选', () => {
    const proj = buildBlockProjection(BODY)
    const methods = proj.nodes.find((n) => n.kind === 'section' && n.heading === 'Methods')!
    const cands = closestTextCandidates(BODY, 'intro body text.', { within: { start: methods.start, end: methods.end } })
    expect(cands.some((c) => c.text.includes('intro body text.'))).toBe(false)
    const within = closestTextCandidates(BODY, 'methods body txt.', { within: { start: methods.start, end: methods.end } })
    expect(within[0].text).toContain('methods body text.')
  })

  test('formatAnchorCandidates:空数组空串;非空带相似度与章节', () => {
    expect(formatAnchorCandidates([])).toBe('')
    const s = formatAnchorCandidates([{ text: 'abc', start: 0, heading: 'H', similarity: 0.91 }])
    expect(s).toContain('abc')
    expect(s).toContain('0.91')
    expect(s).toContain('H')
  })

  test('describeSectionList:列 id+标题;无节文档给出兜底指引', () => {
    const list = describeSectionList(buildBlockProjection(BODY))
    expect(list).toContain('Introduction')
    expect(list).toContain('Methods')
    expect(list).toMatch(/s_[0-9a-f]+/)
    expect(describeSectionList(null)).toContain('没有可用的节结构')
  })
})
