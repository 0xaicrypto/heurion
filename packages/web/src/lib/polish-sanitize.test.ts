import { describe, test, expect } from 'vitest'
import { sanitizePolishOutput } from './polish-sanitize'

/**
 * #752-qa: 润色输出净化(web 侧) — 服务端同名净化器 + 额外的
 * javascript:/data: 链接剥离(TipTap Link 会保留 href,XSS 面)。
 */
describe('sanitizePolishOutput (web)', () => {
  test('剥离 Polished Text 标题 / Key Changes 节 / Let me know 收尾', () => {
    const raw = `Polished Text

正文第一段。

## Key Changes

- 修改了 A
- 修改了 B

Let me know if you'd like another version.`
    const out = sanitizePolishOutput(raw)
    expect(out).toBe('正文第一段。')
  })

  test('剥离 javascript: 链接保留锚文本', () => {
    const raw = '见 [点我](javascript:alert(1)) 与 [官网](https://example.com)。'
    const out = sanitizePolishOutput(raw)
    expect(out).not.toContain('javascript:')
    expect(out).toContain('点我')
    expect(out).toContain('[官网](https://example.com)')
  })

  test('正文中合法的 changes 一词不被误截', () => {
    const body = 'We tracked protocol changes over time.\n\nAnalysis confirms the effect.'
    expect(sanitizePolishOutput(body)).toBe(body)
  })

  test('字面 undefined 前缀清除', () => {
    expect(sanitizePolishOutput('undefined\n\n正文')).toBe('正文')
  })
})
