/**
 * #749 — paragraph-aware text chunking for document vector indexing.
 * Pure functions only (no I/O) so unit tests stay cheap.
 */

export interface ChunkOptions {
  /** Target chunk size in characters. */
  size?: number
  /** Overlap between consecutive chunks (characters). */
  overlap?: number
}

/**
 * Split text for embedding. Prefers \n\n boundaries (paragraphs), falls back
 * to single \n, then hard-slices. Overlap keeps cross-boundary semantics
 * retrievable at query time.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const size = Math.max(64, opts.size ?? 1200)
  const overlap = Math.max(0, Math.min(opts.overlap ?? 150, Math.floor(size / 2)))
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (!clean) return []
  if (clean.length <= size) return [clean]

  const chunks: string[] = []
  let cursor = 0
  while (cursor < clean.length) {
    let end = Math.min(cursor + size, clean.length)
    if (end < clean.length) {
      const window = clean.slice(cursor, end)
      const paraBreak = window.lastIndexOf('\n\n')
      const lineBreak = window.lastIndexOf('\n')
      const spaceish = Math.max(paraBreak, lineBreak)
      // Only respect a break when it is meaningfully inside the window.
      if (spaceish > window.length * 0.5) end = cursor + spaceish + 1
    }
    const piece = clean.slice(cursor, end).trim()
    if (piece) chunks.push(piece)
    if (end >= clean.length) break
    cursor = Math.max(end - overlap, cursor + 1)
  }
  return chunks.length > 0 ? chunks : [clean]
}
