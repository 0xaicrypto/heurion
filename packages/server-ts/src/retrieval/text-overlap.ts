/**
 * #1010 — 轻量关键词重叠（无分词依赖）。
 *
 * 供引用材料选择器"当前场景相关"排序使用，后续 #1008 开局建议可复用：
 * - 拉丁词/数字：长度 ≥2 的小写词；
 * - CJK：连续汉字串取双字 bigram（中文最小语义单元近似）。
 */
export function extractKeywords(text: string): string[] {
  const raw = String(text || '')
  const out = new Set<string>()
  for (const w of raw.toLowerCase().match(/[a-z0-9][a-z0-9-]+/g) || []) out.add(w)
  for (const run of raw.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2))
  }
  return [...out]
}

/** 命中关键词加权求和：CJK bigram 记 1，拉丁词按长度（上限 8）。 */
export function overlapScore(keywords: string[], text: string): number {
  const hay = String(text || '').toLowerCase()
  let score = 0
  for (const k of keywords) {
    if (!k || !hay.includes(k)) continue
    score += /[\u4e00-\u9fff]/.test(k) ? 1 : Math.min(k.length, 8)
  }
  return score
}
