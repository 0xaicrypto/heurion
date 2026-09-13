/**
 * #1021 — 聊天节跳转 / 卡片定位的稳定 id 解析（纯函数，可单测）。
 *
 * 背景：跳转此前用标题文本精确匹配、且取首个命中 — 重名标题会跳错节，
 * 改名后静默失效。这里以投影 section.id 为第一入口：
 *   1) id → 投影节（不存在返回 null，调用方给可见提示）；
 *   2) 按「同标题 + 出现序」落到编辑器里第 N 个同名标题（重复标题正确）；
 *   3) 文本对不上时返回最接近标题并标记 exact=false（调用方提示"已跳到
 *      最接近位置"，不再静默跳错/不动）。
 */

export interface SectionJumpHeading {
  text: string
  level: number
}

export interface SectionJumpSection {
  id: string
  heading?: string
  level?: number
}

export interface SectionJumpTarget {
  /** 目标标题在 headings 数组中的下标。 */
  index: number
  /** true = 标题精确命中；false = 回退到最接近标题（调用方应提示）。 */
  exact: boolean
}

/** 标题规范化 — 与 section-cards 对位同口径（去 markdown 强调/折叠空白/小写）。 */
export function normalizeHeadingText(s: string | undefined): string {
  return (s ?? '').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function bigramDice(a: string, b: string): number {
  const na = normalizeHeadingText(a).replace(/\s/g, '')
  const nb = normalizeHeadingText(b).replace(/\s/g, '')
  if (!na || !nb) return 0
  if (na === nb) return 1
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    if (s.length === 1) m.set(s, 1)
    return m
  }
  const A = grams(na)
  const B = grams(nb)
  let overlap = 0
  let sizeB = 0
  for (const c of B.values()) sizeB += c
  for (const [g, c] of A) overlap += Math.min(c, B.get(g) ?? 0)
  return (2 * overlap) / (na.length - 1 + sizeB || 1)
}

/**
 * 解析跳转目标。返回 null = 该 section id 在当前投影里不存在（调用方提示
 * "该节已不存在"）；exact=false = 投影节存在但编辑器标题对不上（已给最接近）。
 */
export function resolveSectionJumpTarget(
  sections: SectionJumpSection[] | undefined,
  headings: SectionJumpHeading[],
  sectionId: string,
): SectionJumpTarget | null {
  const list = sections ?? []
  const section = list.find((s) => s.id === sectionId)
  if (!section) return null
  const target = normalizeHeadingText(section.heading)
  if (!target) return null

  // 同标题出现序 — 重名标题落到第 N 个（投影与编辑器同文档序）。
  const selfIndex = list.findIndex((s) => s.id === section.id)
  const sameHeadingBefore = list
    .slice(0, selfIndex + 1)
    .filter((s) => normalizeHeadingText(s.heading) === target).length - 1

  const exactHits = headings
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => normalizeHeadingText(h.text) === target)
    .map(({ i }) => i)
  if (exactHits.length > sameHeadingBefore) return { index: exactHits[sameHeadingBefore], exact: true }

  // 回退：最接近标题（相似度 > 0.3 才认为"接近"，否则视为找不到）。
  let bestIdx = -1
  let bestSim = 0
  headings.forEach((h, i) => {
    const sim = bigramDice(section.heading ?? '', h.text)
    if (sim > bestSim) {
      bestSim = sim
      bestIdx = i
    }
  })
  if (bestIdx >= 0 && bestSim >= 0.3) return { index: bestIdx, exact: false }
  return null
}
