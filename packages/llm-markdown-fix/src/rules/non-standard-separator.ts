import type { MarkdownFixRule } from '../index.js'
import { mapOutsideFences, normalizeSeparatorLine, tableCellCount } from './table-utils.js'

/**
 * 非标准分隔行修复 — 把 |--|、---|、|-- 等写成分隔行的形式规范化为
 * 标准 | --- | ... |(标准分隔行原样保留;纯 --- hr 不受影响)。
 * #1149: 对齐冒号保留(旧实现 `:--`/`--:` 被抹成 `---`);围栏内不改。
 */
export const fixNonStandardSeparator: MarkdownFixRule = (md: string) => {
  const isSeparator = (l: string) => /^\s*\|?[-:]+\|?[-: |]*$/.test(l) && l.includes('-')
  const isHr = (l: string) => /^\s*-{3,}\s*$/.test(l)
  const isStandardSep = (l: string) => /^\s*\|(\s*:?-+:?\s*\|){2,}\s*$/.test(l)

  return mapOutsideFences(md, (line, i, lines) => {
    const next = i + 1 < lines.length ? lines[i + 1] : ''
    const prev = i > 0 ? lines[i - 1] : ''
    if (isSeparator(line) && !isHr(line) && !isStandardSep(line) && (prev.includes('|') || next.includes('|'))) {
      const context = prev.includes('|') ? prev : next
      const contextCols = tableCellCount(context)
      const cols = contextCols > 0 ? contextCols : Math.max(1, tableCellCount(line))
      return normalizeSeparatorLine(line, cols)
    }
    return line
  })
}
