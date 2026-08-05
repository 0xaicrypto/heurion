/**
 * §5.4 (#197): single source for token estimation.
 * Rough estimate: latin ~4 chars/token, CJK ~1.5 chars/token.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const latinChars = (text.match(/[a-zA-Z0-9\s]/g) || []).length
  const nonLatinChars = text.length - latinChars
  return Math.ceil(latinChars / 4 + nonLatinChars / 1.5)
}
