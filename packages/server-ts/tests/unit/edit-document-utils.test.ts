import { describe, test, expect } from 'vitest'
import { normalizeForMatch, findNormalizedSpan } from '../../src/tools/edit-document-tool.js'

describe('normalizeForMatch', () => {
  test('collapse any whitespace runs to a single space and trim', () => {
    expect(normalizeForMatch('  a\n\nb\tc   d ')).toBe('a b c d')
  })

  test('remove soft hyphens (U+00AD)', () => {
    expect(normalizeForMatch('diseas\u00ade')).toBe('disease')
  })

  test('non-breaking space counts as whitespace', () => {
    expect(normalizeForMatch('lung\u00a0disease')).toBe('lung disease')
  })
})

describe('findNormalizedSpan', () => {
  const body = 'Impact of two years of treatment\nwith Elexacaftor/Tezacaftor/\nIvacaftor on longitudinal changes.\n\n## Abstract\nThis is the  abstract.'

  test('exact match works as before', () => {
    const span = findNormalizedSpan(body, 'This is the  abstract.')
    expect(span).not.toBeNull()
    expect(body.slice(span!.start, span!.end)).toBe('This is the  abstract.')
  })

  test('needle with different line breaks still matches, span covers the raw text', () => {
    // LLM 复制时把换行折叠成空格,与 PDF 提取的原文换行不同。
    const span = findNormalizedSpan(body, 'Impact of two years of treatment with Elexacaftor/Tezacaftor/ Ivacaftor on longitudinal changes.')
    expect(span).not.toBeNull()
    expect(body.slice(span!.start, span!.end)).toBe('Impact of two years of treatment\nwith Elexacaftor/Tezacaftor/\nIvacaftor on longitudinal changes.')
  })

  test('replacement at a collapsed-whitespace span leaves no residue', () => {
    const span = findNormalizedSpan(body, 'two years of treatment\nwith')
    expect(span).not.toBeNull()
    const newBody = body.slice(0, span!.start) + 'X' + body.slice(span!.end)
    expect(newBody).toBe('Impact of X Elexacaftor/Tezacaftor/\nIvacaftor on longitudinal changes.\n\n## Abstract\nThis is the  abstract.')
  })

  test('soft hyphen in needle matches the same word without it', () => {
    const span = findNormalizedSpan('structural lung diseas\u00ade', 'structural lung disease')
    expect(span).not.toBeNull()
    expect(span!.end - span!.start).toBe('structural lung diseas\u00ade'.length)
  })

  test('no match returns null', () => {
    expect(findNormalizedSpan(body, 'completely different sentence')).toBeNull()
    // 字符不一致(非空白差异)不匹配
    expect(findNormalizedSpan(body, 'Impct of two years')).toBeNull()
  })

  test('empty needle matches at position 0', () => {
    const span = findNormalizedSpan('abc', '   ')
    expect(span).not.toBeNull()
    expect(span!.start).toBe(0)
    expect(span!.end).toBe(0)
  })
})
