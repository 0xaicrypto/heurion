import type { MarkdownFixRule } from '../index.js'

/**
 * 非标准分隔行修复 — 把 |--|、---|、|-- 等写成分隔行的形式规范化为
 * 标准 | --- | ... |(标准分隔行原样保留;纯 --- hr 不受影响)。
 */
export const fixNonStandardSeparator: MarkdownFixRule = (md: string) => {
  const lines = md.split('\n')
  const isSeparator = (l: string) => /^\s*\|?[-:]+\|?[-: |]*$/.test(l) && l.includes('-')
  const isHr = (l: string) => /^\s*-{3,}\s*$/.test(l)
  const isStandardSep = (l: string) => /^\s*\|(\s*:?-+:?\s*\|){2,}\s*$/.test(l)
  const colCount = (l: string) => Math.max(0, (l.match(/\|/g) || []).length - 1)

  return lines.map((line, i) => {
    const next = i + 1 < lines.length ? lines[i + 1] : ''
    const prev = i > 0 ? lines[i - 1] : ''
    if (isSeparator(line) && !isHr(line) && !isStandardSep(line) && (prev.includes('|') || next.includes('|'))) {
      const n = Math.max(1, colCount(prev.includes('|') ? prev : next))
      return `| ${Array(n).fill('---').join(' | ')} |`
    }
    return line
  }).join('\n')
}
