/**
 * #813 — answer-ready 合成契约的归一化层。
 *
 * LLM 产出可信度有限:结构可能缺失(回退 legacy {title,content})、
 * factId可能编造(白名单过滤)。归一化后统一为固定 markdown 结构
 * (结论/依据/注意事项,每个论断回指 factId),注入层与审核 UI 都按
 * 该结构渲染溯源。首行恒为标题 — registry 的提案落库按首行拆标题。
 */

export interface SynthesizedArticle {
  title: string
  content: string
  /** 实际引用且通过白名单的 fact stableId(可观测/测试用)。 */
  citedFactIds: string[]
}

export interface NormalizeSynthesisOptions {
  /** zh → 中文段落标题;en → 英文(regenerate 路径的 researcher persona)。 */
  lang?: 'zh' | 'en'
}

const TITLE_MAX = 120
const QUESTION_MAX = 300
const CONCLUSION_MAX = 1200
const EVIDENCE_MAX = 8
const CAVEATS_MAX = 8

const HEADERS = {
  zh: { question: '回答的问题', conclusion: '结论', evidence: '依据', caveats: '注意事项', confidence: '置信度', conf: { high: '高', medium: '中', low: '低' } },
  en: { question: 'Question', conclusion: 'Conclusion', evidence: 'Evidence', caveats: 'Caveats', confidence: 'confidence', conf: { high: 'high', medium: 'medium', low: 'low' } },
} as const

interface RawEvidenceItem {
  claim?: unknown
  factIds?: unknown
  confidence?: unknown
}

/**
 * 归一化合成结果。返回 null 表示不可用(无标题或完全空)。
 * - 结构化 {title, question, conclusion, evidence, caveats} → 固定 markdown;
 * - legacy {title, content} → 原样通过(合成模型未遵循契约时的兜底);
 * - factIds 过滤到 allowedFactIds(防编造),claim 无有效引用时丢弃。
 */
export function normalizeSynthesizedArticle(
  parsed: unknown,
  allowedFactIds: string[],
  options: NormalizeSynthesisOptions = {},
): SynthesizedArticle | null {
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  const title = typeof p.title === 'string' ? p.title.trim().slice(0, TITLE_MAX) : ''
  if (!title) return null

  const allowed = new Set(allowedFactIds)

  // legacy 形态:{title, content} — 无法强转结构时原样保留。
  // 首行=标题不变量必须维持(registry 提案落库按首行拆标题)。
  const legacyContent = typeof p.content === 'string' ? p.content.trim() : ''
  const hasStructured = typeof p.conclusion === 'string' && p.conclusion.trim().length > 0
  if (!hasStructured) {
    if (!legacyContent) return null
    return { title, content: legacyContent.startsWith(title) ? legacyContent : `${title}\n\n${legacyContent}`, citedFactIds: [] }
  }

  const t = HEADERS[options.lang === 'en' ? 'en' : 'zh']
  const lines: string[] = [title, '']
  const question = typeof p.question === 'string' ? p.question.trim().slice(0, QUESTION_MAX) : ''
  if (question) lines.push(`> ${t.question}: ${question}`, '')

  lines.push(`### ${t.conclusion}`, String(p.conclusion).trim().slice(0, CONCLUSION_MAX), '')

  const cited = new Set<string>()
  const evidence = Array.isArray(p.evidence) ? (p.evidence as RawEvidenceItem[]) : []
  const evidenceLines: string[] = []
  for (const item of evidence.slice(0, EVIDENCE_MAX)) {
    if (!item || typeof item !== 'object') continue
    const claim = typeof item.claim === 'string' ? item.claim.trim() : ''
    if (!claim) continue
    const ids = Array.isArray(item.factIds)
      ? (item.factIds as unknown[]).filter((id): id is string => typeof id === 'string' && allowed.has(id))
      : []
    if (ids.length === 0) continue // 无有效引用的论断不进依据(契约:可溯源)
    ids.forEach((id) => cited.add(id))
    const conf = typeof item.confidence === 'string' && item.confidence in t.conf
      ? t.conf[item.confidence as keyof typeof t.conf]
      : t.conf.medium
    evidenceLines.push(`- ${claim}（${ids.join(', ')}｜${t.confidence}: ${conf}）`)
  }
  lines.push(`### ${t.evidence}`, ...(evidenceLines.length > 0 ? evidenceLines : [`- （${options.lang === 'en' ? 'no traceable evidence' : '无可溯源依据'}）`]))

  const caveats = Array.isArray(p.caveats)
    ? (p.caveats as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim().length > 0).slice(0, CAVEATS_MAX)
    : typeof p.caveats === 'string' && p.caveats.trim() ? [p.caveats.trim()] : []
  if (caveats.length > 0) {
    lines.push('', `### ${t.caveats}`, ...caveats.map((c) => `- ${c.trim()}`))
  }

  return { title, content: lines.join('\n'), citedFactIds: Array.from(cited) }
}
