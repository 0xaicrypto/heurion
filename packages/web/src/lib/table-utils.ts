/**
 * Table recovery for LLM output. LLMs commonly emit tables that GFM will
 * NOT parse as tables:
 *   1. missing the `|--|` delimiter row (no delimiter → plain paragraph)
 *   2. missing blank lines around the table (swallowed by adjacent text)
 *   3. raw HTML `<table>` (react-markdown renders no raw HTML without
 *      rehypeRaw — the user sees the markup itself)
 *
 * recoverTables rewrites those into valid GFM tables. HTML is converted by
 * extracting text content only (no tag passthrough → no XSS surface).
 */

function isPipeRow(line: string): boolean {
  return /^\s*\|.*\|.*\|\s*$/.test(line) && (line.match(/\|/g) || []).length >= 2
}

function isDelimiterRow(line: string): boolean {
  return /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes('-')
}

function columnCount(line: string): number {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '').replace(/\s+$/, '')
  const cells = trimmed.split('|')
  return cells.length
}

function htmlTableToGfm(html: string): string | null {
  const rows: string[][] = []
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const cells: string[] = []
    const cellRe = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi
    let cellMatch: RegExpExecArray | null
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      const content = cellMatch[2]
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      cells.push(content)
    }
    if (cells.length > 0) rows.push(cells)
  }
  if (rows.length === 0) return null
  const colCount = Math.max(...rows.map((r) => r.length))
  const line = (cells: string[]) => `| ${Array.from({ length: colCount }, (_, i) => cells[i] ?? '').join(' | ')} |`
  const sep = `| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`
  return [line(rows[0]), sep, ...rows.slice(1).map(line)].join('\n')
}

export function recoverTables(text: string): string {
  if (!text) return text

  // 1) Raw HTML tables → GFM
  const t = text.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (match, body: string) => {
    const gfm = htmlTableToGfm(body)
    return gfm ?? match
  })

  // 2) Pipe rows without a delimiter row + missing blank lines
  const lines = t.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (isPipeRow(lines[i])) {
      const block: string[] = []
      while (i < lines.length && isPipeRow(lines[i])) {
        block.push(lines[i])
        i++
      }
      const hasDelimiter = block.some(isDelimiterRow)
      if (!hasDelimiter && block.length >= 2) {
        const cols = Math.max(...block.map(columnCount))
        const sep = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`
        if (out.length > 0 && out[out.length - 1] !== '') out.push('')
        out.push(block[0], sep, ...block.slice(1))
        if (i < lines.length && lines[i] !== '') out.push('')
      } else {
        out.push(...block)
      }
    } else {
      out.push(lines[i])
      i++
    }
  }
  return out.join('\n')
}
