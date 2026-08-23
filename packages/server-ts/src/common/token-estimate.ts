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

/**
 * #fix: 把文本裁剪到指定 token 预算内(二分搜索,脚本感知 — 中文按 1.5
 * 字符/token、英文按 4 字符/token)。返回不超过预算的最大前缀。
 */
export function fitTextToTokens(text: string, maxTokens: number, minChars = 200): string {
  if (!text || maxTokens <= 0) return ''
  if (estimateTokens(text) <= maxTokens) return text
  let low = Math.min(minChars, text.length)
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (estimateTokens(text.slice(0, mid)) > maxTokens) {
      high = mid - 1
    } else {
      low = mid
    }
  }
  return text.slice(0, low)
}
