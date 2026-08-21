import type { MarkdownFixRule, FixOptions } from '../index.js'

/**
 * 单行表格展开 — 模型常把整个表格挤成一行
 * (On-Chain Reality| Asset |...| |---|---| | WETH |...|| WMNT |...)。
 * 检测"管道密集 + 分隔段"的行,按分隔段/表头列数拆分为标准多行表格。
 */
export const fixSingleLineTables: MarkdownFixRule = (md: string) => {
  return md.split('\n').map((line) => expandSingleLineTable(line) ?? line).join('\n')
}

function expandSingleLineTable(line: string): string | null {
  if ((line.match(/\|/g) || []).length < 4) return null
  const sepIdx = line.search(/\|[-:]{1,}\|/)
  if (sepIdx < 0) return null
  const headerRaw = line.slice(0, sepIdx)
  const sepMatch = line.slice(sepIdx).match(/^\|?[-:]{1,}(\|[-:]{1,})+\|?/)
  if (!sepMatch) return null
  const dataRaw = line.slice(sepIdx + sepMatch[0].length)
  if (!dataRaw.includes('|')) return null

  const headerCells = headerRaw.split('|').map((s) => s.trim()).filter((s) => s !== '')
  if (headerCells.length === 0) return null
  // 列数以"分隔行列数"为准(数据行往往比表头少一列 — 模型输出不一致)。
  const sepCells = sepMatch[0].split('|').map((s) => s.trim()).filter((s) => s !== '')
  const cols = Math.max(1, sepCells.length)
  const hdrCells = headerCells.slice(0, cols)
  while (hdrCells.length < cols) hdrCells.push('')
  const hdr = `| ${hdrCells.join(' | ')} |`
  const sepLine = `| ${Array(cols).fill('---').join(' | ')} |`
  const cells = dataRaw.split('|').map((s) => s.trim()).filter((s) => s !== '')
  const rows: string[] = []
  for (let i = 0; i < cells.length; i += cols) {
    rows.push(`| ${cells.slice(i, i + cols).join(' | ')} |`)
  }
  return [hdr, sepLine, ...rows].join('\n')
}
