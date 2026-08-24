import { describe, test, expect } from 'vitest'
import { normalizeForMatch, findNormalizedSpan, findFuzzySpan } from '../../src/tools/edit-document-tool.js'

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

  test('strip markdown heading markers, emphasis, code and case', () => {
    expect(normalizeForMatch('## Abstract\n\n**Rationale**\n\n`code` and Elexacaftor')).toBe('abstract rationale code and elexacaftor')
  })

  test('strip image markdown tokens', () => {
    expect(normalizeForMatch('a ![图 1](/api/v1/files/download/img_x.png?token=t) b')).toBe('a b')
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

  test('#fix: needle omitting markdown heading markers still matches (LLM 复制时去掉 ##)', () => {
    const span = findNormalizedSpan(body, 'Abstract This is the abstract.')
    expect(span).not.toBeNull()
    // 命中片段从标题文本开始(## 标记两侧归一化后不含)
    expect(body.slice(span!.start, span!.end)).toBe('Abstract\nThis is the  abstract.')
  })

  test('#fix: case differences are ignored', () => {
    const span = findNormalizedSpan('Elexacaftor/Tezacaftor/Ivacaftor', 'elexacaftor/tezacaftor/ivacaftor')
    expect(span).not.toBeNull()
  })

  test('#fix: span can cross an embedded image markdown token', () => {
    const b = 'before ![图 1](/api/v1/files/download/img_doc_x_1.png?token=t) after'
    const span = findNormalizedSpan(b, 'before after')
    expect(span).not.toBeNull()
    expect(b.slice(span!.start, span!.end)).toBe(b)
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

describe('findFuzzySpan', () => {
  const body = 'Automated analysis showed a significant reduction in BwtAand Bwa/Boa at 12 months which were sustained to 24 months.'

  test('#fix: small character differences (model 脑补修正拼写) still match', () => {
    const span = findFuzzySpan(body, 'Automated analysis showed a significant reduction in Bwt/A and Bwa/Boa at 12 months which were sustained to 24 months.')
    expect(span).not.toBeNull()
    expect(span!.fuzzy).toBe(true)
    expect(body.slice(span!.start, span!.end)).toContain('BwtAand')
  })

  test('large differences are rejected', () => {
    expect(findFuzzySpan(body, 'This is a completely unrelated sentence about something else entirely.')).toBeNull()
  })

  test('empty needle rejected', () => {
    expect(findFuzzySpan(body, '   ')).toBeNull()
  })
})
