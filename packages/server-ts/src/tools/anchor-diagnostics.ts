/**
 * #1020/#1022 — 锚点失败结构化诊断（纯函数，无 IO）。
 *
 * 背景：edit_document 的 old_text 未命中时只回一句"没找到"，模型只能凭空
 * 再猜一次（长文档/中文标点差异下重试风暴）。这里提供两件诊断材料：
 *  - 最接近候选片段（行/多行窗口 + bigram Dice 相似度 + 所属章节），
 *    供模型一次修正；
 *  - 当前可用节清单（id+标题），section_id 失效时不必再猜。
 * 同时被 edit_document 的全局 range 失败与 section 范围失败复用。
 */
import { normalizeForMatch } from '../lib/document-span-match.js'
import { nearestHeadingBefore, HEADING_RE } from '../lib/doc-sections.js'
import type { BlockProjection } from '@heurion/contracts'

export interface AnchorCandidate {
  /** 候选片段原文（超长截断）。 */
  text: string
  /** body 中的绝对起点。 */
  start: number
  /** 片段之前最近的 markdown 标题（可空）。 */
  heading: string
  /** 0..1 相似度（bigram Dice）。 */
  similarity: number
}

/** 归一化后的 bigram Dice 相似度（0..1；空串为 0）。 */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeForMatch(a).replace(/\s/g, '')
  const nb = normalizeForMatch(b).replace(/\s/g, '')
  if (!na || !nb) return 0
  if (na === nb) return 1
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    if (s.length === 1) m.set(s, 1)
    return m
  }
  const A = bigrams(na)
  const B = bigrams(nb)
  let overlap = 0
  let sizeB = 0
  for (const c of B.values()) sizeB += c
  for (const [g, c] of A) overlap += Math.min(c, B.get(g) ?? 0)
  return (2 * overlap) / (na.length - 1 + sizeB || 1)
}

export interface ClosestCandidatesOptions {
  /** 限定在 body 的该区间内找候选（section 范围失败时用，避免引导模型改错节）。 */
  within?: { start: number; end: number }
  limit?: number
}

/**
 * 在 body（或 within 区间）内找与 needle 最接近的行/多行窗口候选。
 * 开销有界：单行 + 最多 3 行窗口，排序取 top N。标题行本身不作为候选。
 */
export function closestTextCandidates(
  body: string,
  needle: string,
  opts: ClosestCandidatesOptions = {},
): AnchorCandidate[] {
  const regionStart = Math.max(0, opts.within?.start ?? 0)
  const regionEnd = Math.min(opts.within?.end ?? body.length, body.length)
  if (regionEnd <= regionStart || !needle.trim()) return []
  const text = body.slice(regionStart, regionEnd)
  const lines = text.split('\n')
  const offsets: number[] = []
  let off = regionStart
  for (const l of lines) {
    offsets.push(off)
    off += l.length + 1
  }
  const limit = opts.limit ?? 3
  const cands: AnchorCandidate[] = []
  const pushWindow = (i: number, j: number) => {
    const raw = lines.slice(i, j + 1).join('\n').trim()
    if (raw.length < 3) return
    const start = offsets[i] + (lines[i].length - lines[i].trimStart().length)
    cands.push({
      text: raw.length > 240 ? `${raw.slice(0, 240)}…` : raw,
      start,
      heading: nearestHeadingBefore(body, start),
      similarity: Math.round(textSimilarity(needle, raw) * 100) / 100,
    })
  }
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim() || HEADING_RE.test(lines[i])) continue
    pushWindow(i, i)
    if (i + 1 < lines.length && lines[i + 1].trim() && !HEADING_RE.test(lines[i + 1])) pushWindow(i, i + 1)
    if (i + 2 < lines.length && lines[i + 1].trim() && lines[i + 2].trim()) pushWindow(i, i + 2)
  }
  cands.sort((a, b) => b.similarity - a.similarity)
  const out: AnchorCandidate[] = []
  for (const c of cands) {
    if (out.length >= limit) break
    if (out.some((o) => Math.abs(o.start - c.start) < 10)) continue
    out.push(c)
  }
  return out
}

/** 候选片段 → 模型可复制的诊断文本（无候选返回空串）。 */
export function formatAnchorCandidates(candidates: AnchorCandidate[]): string {
  if (candidates.length === 0) return ''
  return candidates
    .map((c, i) => `${i + 1}) ${c.heading ? `「${c.heading}」内 ` : ''}"${c.text}"（相似度 ${c.similarity.toFixed(2)}）`)
    .join(' ')
}

/** 当前投影的可用节清单（id+标题），section id 失效/未命中时报给模型。 */
export function describeSectionList(projection: BlockProjection | null | undefined, limit = 12): string {
  const sections = (projection?.nodes ?? []).filter((n) => n.kind === 'section')
  if (sections.length === 0) return '(文档当前没有可用的节结构 — 请用 old_text/new_text 锚点编辑)'
  const shown = sections.slice(0, limit).map((s, i) => `${i + 1}. ${s.id}「${s.heading || ''}」`)
  const more = sections.length > limit ? ` …共 ${sections.length} 节` : ''
  return `${shown.join('；')}${more}`
}
