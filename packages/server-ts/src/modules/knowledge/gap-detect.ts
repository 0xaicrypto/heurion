/**
 * #645: pure helpers for chat→knowledge-gap detection, extracted from
 * chat.orchestrator's postTurn inline logic. Single source for question
 * shaping + CJK-aware keyword extraction (was duplicated inline).
 */

/** CJK-aware keyword extraction: latin tokens as-is, Chinese via 2-grams
 *  (split(/\s+/) does not segment Chinese — a whole sentence becomes one
 *  token and keyword overlap never matches). Stopwords are dropped. */
export function extractCjkKeywords(text: string): string[] {
  const clean = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')
  const STOP = /^(患者|病人|医生|这个|那个|我们|你们|他们|请问|没有|一下|的话)$/
  const words = new Set<string>()
  for (const token of clean.split(/\s+/)) {
    if (!token) continue
    if (/[\p{Script=Han}]/u.test(token)) {
      for (let i = 0; i < token.length - 1; i++) {
        const bigram = token.slice(i, i + 2)
        if (!STOP.test(bigram) && /[\p{Script=Han}]/u.test(bigram)) words.add(bigram)
      }
    } else if (token.length >= 2 && token.length <= 6) {
      words.add(token)
    }
  }
  return [...words]
}

/** Question-shaped message heuristic (K6): ?/？/如何/是否/为什么/哪些… */
export function detectQuestionShaped(text: string): boolean {
  return /[?？]|如何|怎样|怎么|为什么|为何|是否|是不是|有没有|是什么|哪些|哪个/.test(text)
}
