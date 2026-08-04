import fs from 'fs'
import path from 'path'

/**
 * T1 — bounded tool output (#101, opencode tool-output-store parity).
 *
 * Large tool results are truncated (head + tail sampling with a marker)
 * before being injected into the next LLM round, so search_node-style dumps
 * can't blow up the context budget. The FULL result is persisted to disk
 * (7-day retention) and the path is included in the marker.
 *
 * Limits: TOOL_OUTPUT_MAX_LINES (default 2000) / TOOL_OUTPUT_MAX_BYTES
 * (default 50 KB), env-configurable.
 */

const MAX_LINES = parseInt(process.env.TOOL_OUTPUT_MAX_LINES || '2000', 10)
const MAX_BYTES = parseInt(process.env.TOOL_OUTPUT_MAX_BYTES || (50 * 1024).toString(), 10)
const RETENTION_MS = 7 * 24 * 3600 * 1000

export interface BoundedResult {
  bounded: string
  truncated: boolean
  filePath: string | null
}

export function toolOutputDir(): string {
  return path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', 'tool-output')
}

function safeSliceToBytes(text: string, maxBytes: number): string {
  // Iterate code points so multi-byte characters are never cut in half.
  let size = 0
  let out = ''
  for (const ch of text) {
    const byteLen = Buffer.byteLength(ch, 'utf-8')
    if (size + byteLen > maxBytes) break
    out += ch
    size += byteLen
  }
  return out
}

export function saveFullOutput(userId: string, content: string): string {
  const dir = path.join(toolOutputDir(), userId)
  fs.mkdirSync(dir, { recursive: true })
  const id = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const filePath = path.join(dir, id)
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

/**
 * Bound a tool output. Returns it untouched when within limits; otherwise
 * head+tail sampling (each half of the budget) with a marker that names the
 * persisted full file.
 */
export function boundToolOutput(
  output: string,
  opts: { userId?: string; maxLines?: number; maxBytes?: number } = {},
): BoundedResult {
  if (!output) return { bounded: output, truncated: false, filePath: null }

  const maxLines = opts.maxLines ?? MAX_LINES
  const maxBytes = opts.maxBytes ?? MAX_BYTES

  const lines = output.split('\n')
  const overLines = lines.length > maxLines
  const overBytes = Buffer.byteLength(output, 'utf-8') > maxBytes
  if (!overLines && !overBytes) return { bounded: output, truncated: false, filePath: null }

  const filePath = saveFullOutput(opts.userId || 'anonymous', output)

  let bounded: string
  if (overLines) {
    const half = Math.floor(maxLines / 2)
    const head = lines.slice(0, half)
    const tail = lines.slice(lines.length - half)
    bounded = `${head.join('\n')}\n${tail.join('\n')}`
  } else {
    // Byte bound: fill from head and tail until half the budget each.
    const halfBytes = Math.floor(maxBytes / 2)
    const byteLines = output.split('\n')
    let headSize = 0
    let headLines: string[] = []
    for (const l of byteLines) {
      const b = Buffer.byteLength(l, 'utf-8') + 1
      if (headSize + b > halfBytes) break
      headLines.push(l)
      headSize += b
    }
    let tailSize = 0
    let tailLines: string[] = []
    for (let i = byteLines.length - 1; i >= 0; i--) {
      const b = Buffer.byteLength(byteLines[i], 'utf-8') + 1
      if (tailSize + b > halfBytes) break
      tailLines.unshift(byteLines[i])
      tailSize += b
    }
    bounded = `${headLines.join('\n')}\n${tailLines.join('\n')}`
  }

  // UTF-8 safety: the final result must never exceed the byte budget with a
  // cut multi-byte char.
  bounded = safeSliceToBytes(bounded, maxBytes)

  bounded += `\n\n... output truncated; full content saved to ${filePath} ...`
  return { bounded, truncated: true, filePath }
}

/** Remove tool-output files older than the retention window. Returns count. */
export function cleanupToolOutputs(maxAgeMs: number = RETENTION_MS): number {
  const dir = toolOutputDir()
  if (!fs.existsSync(dir)) return 0
  const now = Date.now()
  let removed = 0
  for (const user of fs.readdirSync(dir)) {
    const userDir = path.join(dir, user)
    let stat: fs.Stats
    try { stat = fs.statSync(userDir) } catch { continue }
    if (!stat.isDirectory()) continue
    for (const f of fs.readdirSync(userDir)) {
      const fp = path.join(userDir, f)
      try {
        const s = fs.statSync(fp)
        if (now - s.mtimeMs > maxAgeMs) {
          fs.unlinkSync(fp)
          removed++
        }
      } catch { /* ignore */ }
    }
  }
  return removed
}
