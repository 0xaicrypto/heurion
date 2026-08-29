import { describe, test, expect } from 'vitest'
import { sanitizePolishOutput } from '../../src/lib/polish-sanitize.js'

/**
 * #752-qa: 润色输出常混入模型元评论("Polished Text" 标题、"Key Changes"
 * 修改说明、"Let me know…" 收尾语)——这些绝不能写进用户文档。
 * 生产实例:用户正文被写入 "undefined / Polished Text / … / Key Changes
 * / Repaired line-break artifacts: … / Let me know if you'd like…"
 */
describe('sanitizePolishOutput (#752-qa)', () => {
  test('生产实例:标题+正文+Key Changes+收尾语 全部净化', () => {
    const raw = `undefined

Polished Text

…often lack detailed facility-level PUE integration. Furthermore, studies of dynamic grid carbon intensity have shown that annual average emission factors obscure fluctuations.

## Key Changes

Repaired line-break artifacts: rejoined hyphenated words.

Let me know if you'd like a version with different stylistic conventions.`
    const out = sanitizePolishOutput(raw)
    expect(out).not.toContain('undefined')
    expect(out).not.toContain('Polished Text')
    expect(out).not.toContain('Key Changes')
    expect(out).not.toContain('Let me know')
    expect(out).toContain('often lack detailed facility-level PUE integration')
  })

  test('无元评论的纯正文原样保留', () => {
    const body = 'This study demonstrates a significant survival benefit.'
    expect(sanitizePolishOutput(body)).toBe(body)
  })

  test('中文元评论形态同样处理', () => {
    const raw = `润色后文本

本研究纳入了 120 例患者。

主要修改
- 统一了术语
- 修正了标点

如果需要进一步调整语气,请告诉我。`
    const out = sanitizePolishOutput(raw)
    expect(out).toBe('本研究纳入了 120 例患者。')
  })

  test('正文中间合法提及 changes 一词不被误截(仅在行首作标题时截断)', () => {
    const body = `We tracked protocol changes over time.

The analysis confirms the effect.`
    const out = sanitizePolishOutput(body)
    expect(out).toContain('protocol changes over time')
    expect(out).toContain('analysis confirms')
  })

  test('空输入返回空串', () => {
    expect(sanitizePolishOutput('')).toBe('')
    expect(sanitizePolishOutput('undefined')).toBe('')
  })
})
