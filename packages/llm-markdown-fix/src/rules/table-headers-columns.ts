import type { MarkdownFixRule } from '../index.js'
import { mapOutsideFences, normalizeSeparatorLine, tableCellCount } from './table-utils.js'

/**
 * 表头/分隔/数据列数一致性修复:
 *  - 表头行缺前导 |(如 'On-Chain Reality| Asset |')→ 补全
 *  - 表头列数与分隔行不一致 → 以分隔行列数为准(表头截取/补齐)
 *  - #1149: 列数按单元格计(无尾部管道不少算);代码围栏内不改;对齐冒号保留
 */
export const fixTableHeadersAndColumns: MarkdownFixRule = (md: string) => {
  const isSeparator = (l: string) => /^\s*\|?[-:]+\|?[-: |]*$/.test(l) && l.includes('-')
  const isHr = (l: string) => /^\s*-{3,}\s*$/.test(l)

  let forceCols: number | null = null
  return mapOutsideFences(md, (line, i, lines) => {
    const next = i + 1 < lines.length ? lines[i + 1] : ''
    const prev = i > 0 ? lines[i - 1] : ''

    // 1) 表头行缺前导 | 且下一行是分隔行 → 补前导 |,并强制分隔行列数
    //    与表头一致(模型可能少写一列分隔)。
    if (line.includes('|') && !line.trim().startsWith('|') && isSeparator(next) && !isHr(next)) {
      const header = '| ' + line.trim()
      forceCols = Math.max(1, tableCellCount(header))
      return header
    }
    // 2) 分隔行(非 hr,处于表格上下文)→ 若被强制重写或非标准,规范列数。
    if (isSeparator(line) && !isHr(line) && (forceCols != null || prev.includes('|') || next.includes('|'))) {
      if (forceCols != null) {
        const n = forceCols
        forceCols = null
        return normalizeSeparatorLine(line, n)
      }
    }
    forceCols = null
    return line
  })
}
