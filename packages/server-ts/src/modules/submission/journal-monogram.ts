/**
 * #852/D6 — ISSN monogram logo:首字母字标 + 出版商色板。
 * 零版权风险:不逐刊抓取官方 logo,只用刊名首字母 + 确定性取色。
 */

const STOPWORDS = new Set(['the', 'of', 'in', 'and', 'for', 'on', 'a', 'an', 'journal', 'journals', 'chinese'])

/** 出版商色板 — 医学出版常用色相环,16 色保证区分度。 */
const PALETTE = [
  '#0f766e', '#1d4ed8', '#7c3aed', '#b91c1c', '#b45309', '#15803d', '#be185d', '#0369a1',
  '#4d7c0f', '#9333ea', '#c2410c', '#0e7490', '#6d28d9', '#a16207', '#166534', '#9f1239',
]

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

/**
 * "Journal of Clinical Oncology" → "CO";"New England Journal of Medicine" → "NE";
 * 中文刊 "中华心血管病杂志" → "中"(CJK 取首字)。
 */
export function buildMonogram(name: string): { monogram: string; color: string } {
  const latinWords = name
    .replace(/[^A-Za-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w.toLowerCase()))
  let monogram: string
  if (latinWords.length >= 2) {
    monogram = (latinWords[0][0] + latinWords[1][0]).toUpperCase()
  } else if (latinWords.length === 1) {
    monogram = latinWords[0].slice(0, 2).toUpperCase()
  } else {
    monogram = name.trim().slice(0, 1) // CJK 兜底
  }
  const color = PALETTE[hashString(name) % PALETTE.length]
  return { monogram, color }
}
