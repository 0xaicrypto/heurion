import type { MarkdownFixRule, FixOptions } from '../index.js'

/**
 * 标点/短符号 code 化修复 — 模型用 ``` 围栏包裹单个标点或短符号
 * (如 ```..```、```.```)。围栏无语言标注且内容极短(≤maxShortCodeLen
 * 字符、无换行)时,按普通文本还原,避免"明明不是代码却显示成 code"。
 */
export const fixPunctuationCode: MarkdownFixRule = (md: string, options: FixOptions) => {
  const maxLen = options?.maxShortCodeLen ?? 4
  const fence = /```[^\n]*\n([\s\S]*?)\n```/g
  return md.replace(fence, (_m, inner: string) => {
    const text = String(inner).replace(/\n$/, '').trim()
    if (text.length > 0 && text.length <= maxLen && !text.includes('\n')) {
      return text
    }
    return _m
  })
}
