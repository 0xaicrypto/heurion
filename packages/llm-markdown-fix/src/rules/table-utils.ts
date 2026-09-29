/**
 * #1149 — 表格规则共享工具（列数口径 / 围栏跳过 / 对齐保留）。
 */

/** 是否是代码围栏行（``` 或 ~~~，可带 info string）。 */
export function isFenceLine(line: string): boolean {
  return /^\s*(```|~~~)/.test(line)
}

/** 仅对代码围栏之外的行应用 fn（围栏行原样保留）。 */
export function mapOutsideFences(
  md: string,
  fn: (line: string, i: number, lines: string[]) => string,
): string {
  const lines = md.split('\n')
  let inFence = false
  return lines
    .map((line, i) => {
      if (isFenceLine(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return fn(line, i, lines)
    })
    .join('\n')
}

/**
 * 表格行单元格数。修复旧实现 `管道数 - 1`：无尾部管道的
 * `A | B | C` 有 3 列而非 2 列（少算一列 → 分隔行被截成 2 列，数据错位）。
 * 前导/尾部管道是边界符，不产生空单元格。
 */
export function tableCellCount(line: string): number {
  const t = line.trim()
  if (!t.includes('|')) return 0
  const parts = t.split('|')
  if (parts.length > 0 && parts[0].trim() === '') parts.shift()
  if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop()
  return parts.length
}

/** 拆分单元格文本（保留内部空位；仅去掉边界符产生的首尾空段）。 */
export function splitTableCells(line: string): string[] {
  const parts = line.trim().split('|')
  if (parts.length > 0 && parts[0].trim() === '') parts.shift()
  if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop()
  return parts
}

/** 分隔单元格规范化 — 保留对齐冒号（`:---` / `---:` / `:---:`）。 */
export function normalizeSepCell(cell: string): string {
  const t = cell.trim()
  const left = t.startsWith(':')
  const right = t.endsWith(':')
  return `${left ? ':' : ''}---${right ? ':' : ''}`
}

/** 按目标列数重建分隔行 — 沿用原行对齐冒号，不足补 `---`，超出截断。 */
export function normalizeSeparatorLine(line: string, cols: number): string {
  const n = Math.max(1, cols)
  const own = splitTableCells(line).map(normalizeSepCell)
  const cells = Array.from({ length: n }, (_, i) => own[i] ?? '---')
  return `| ${cells.join(' | ')} |`
}
