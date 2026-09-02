import { describe, test, expect } from 'vitest'
import { normalizeForMatch, findNormalizedSpan, findFuzzySpan } from '../../src/lib/document-span-match.js'

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

  test('image markdown token → 占位符+URL(参与匹配,不再整段删除)', () => {
    expect(normalizeForMatch('a ![图 1](/api/v1/files/download/img_x.png?token=t) b')).toBe(
      'a \uFFFC/api/v1/files/download/img_x.png?token=t b',
    )
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

  test('#fix: needle 含图片 token 时 span 覆盖图片本体', () => {
    const b = 'before ![图 1](/api/v1/files/download/img_doc_x_1.png?token=t) after'
    const span = findNormalizedSpan(b, 'before ![图 1](/api/v1/files/download/img_doc_x_1.png?token=t) after')
    expect(span).not.toBeNull()
    expect(b.slice(span!.start, span!.end)).toBe(b)
  })

  test('#fix: 跨图片但不含图片的 needle 不再命中(防静默删图)', () => {
    const b = 'before ![图 1](/api/v1/files/download/img_doc_x_1.png?token=t) after'
    expect(findNormalizedSpan(b, 'before after')).toBeNull()
  })

  test('no match returns null', () => {
    expect(findNormalizedSpan(body, 'completely different sentence')).toBeNull()
    // 字符不一致(非空白差异)不匹配
    expect(findNormalizedSpan(body, 'Impct of two years')).toBeNull()
  })

  test('#fix: 纯空白/纯标记 old_text 归一化后为空 → null(空锚点守卫)', () => {
    expect(findNormalizedSpan('abc', '   ')).toBeNull()
    expect(findNormalizedSpan('abc', '***')).toBeNull()
  })
})

describe('findNormalizedSpan: 图片锚点(#fix 换图工作流 — 假「出现多次」死循环根治)', () => {
  const doc = [
    '## 一、背景',
    '',
    '**图1：剂量对比**',
    '',
    '![图1：剂量对比](/api/v1/files/download/chart_111.svg?token=a1)',
    '',
    '**图2：布拉格峰**',
    '',
    '![图2：布拉格峰](/api/v1/files/download/chart_222.svg?token=a2)',
    '',
    '正文结尾。',
  ].join('\n')

  const fig1 = '![图1：剂量对比](/api/v1/files/download/chart_111.svg?token=a1)'

  test('整行图片做 old_text — 按 URL 精确命中,span 覆盖图片本体', () => {
    const span = findNormalizedSpan(doc, fig1)
    expect(span).not.toBeNull()
    expect(doc.slice(span!.start, span!.end)).toBe(fig1)
  })

  test('URL 不同的图片不会互相误配', () => {
    expect(findNormalizedSpan(doc, '![x](/api/v1/files/download/chart_999.svg?token=zz)')).toBeNull()
  })

  test('图题+图片 old_text — 替换 span 覆盖到图片本体(旧图不再残留)', () => {
    const needle = '**图1：剂量对比**\n\n' + fig1
    const span = findNormalizedSpan(doc, needle)
    expect(span).not.toBeNull()
    expect(doc.slice(span!.start, span!.end)).toBe(needle)
  })

  test('仅图题 old_text — span 停在图题末尾,不吞图片', () => {
    const span = findNormalizedSpan(doc, '**图1：剂量对比**')
    expect(span).not.toBeNull()
    expect(doc.slice(span!.start, span!.end)).toBe('**图1：剂量对比**')
  })

  test('同 URL 多张图 — 第一处命中且 span 对准第一个 token', () => {
    const dup = '![a](/u.svg) 中间 ![b](/u.svg)'
    const span = findNormalizedSpan(dup, '![a](/u.svg)')
    expect(span).not.toBeNull()
    expect(dup.slice(span!.start, span!.end)).toBe('![a](/u.svg)')
  })

  test('模糊匹配兜底对含图片锚点同样覆盖图片本体', () => {
    const b = '图题一 **图1：剂量对比**\n\n![图1：剂量对比](/api/v1/files/download/chart_111.svg?token=a1) 结尾'
    const span = findFuzzySpan(b, '图题一 **图1：剂量对比**\n\n![图1：剂量对比](/api/v1/files/download/chart_111.svg?token=a!) 结尾')
    expect(span).not.toBeNull()
    expect(span!.fuzzy).toBe(true)
    expect(b.slice(span!.start, span!.end)).toBe('图题一 **图1：剂量对比**\n\n![图1：剂量对比](/api/v1/files/download/chart_111.svg?token=a1) 结尾')
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
