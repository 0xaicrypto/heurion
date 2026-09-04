/**
 * #839 缺口 2 — 记忆引用输出侧对账(移植 #807「References 强制命中真实检索」模式)。
 *
 * 合成侧已有 factId 白名单防幻觉(summary-contract.ts),但 chat 输出侧此前只有
 * prompt 约束(KB_CITATION_RULE)+ 注入披露(citations SSE #756)——只披露"注入了
 * 什么",不校验"输出是否真引用了注入条目"。本校验器对模型输出中的 KB 引用标注
 * 做对账:未命中本轮注入集合的引用降级"未溯源"标注,不让幻觉引用静默过境。
 *
 * 范围边界:只处理 KB_CITATION_RULE 规定的引用格式(（来源：《标题》）),
 * PubMed/PMID 等外部文献引用归 #807 CITATION_RULE(检索工具锚定)管辖,不在此拦截。
 */

export interface KbCitationMarker {
  raw: string
  title: string
  confidence?: string
}

export interface CitationAuditResult {
  /** 输出中发现的 KB 引用标注总数 */
  total: number
  /** 命中本轮注入集合的引用数 */
  verified: number
  /** 未命中注入集合的引用(幻觉/过期标题) */
  unverified: Array<{ raw: string; title: string }>
  /** 未命中条目降级"未溯源"后的文本;全部命中时与输入相同 */
  annotatedText: string
}

// KB_CITATION_RULE 规定格式:（来源：《摘要标题》，置信度: 高）— 全/半角
// 括号与冒号均容忍,置信度段可选。
const MARKER_RE = /([（(])\s*来源\s*[:：]\s*《([^《》]{1,160})》\s*(?:[,，;；]\s*置信度\s*[:：]?\s*(高|中|低))?\s*([)）])/g

export function extractCitationMarkers(text: string): KbCitationMarker[] {
  const out: KbCitationMarker[] = []
  for (const m of text.matchAll(MARKER_RE)) {
    out.push({ raw: m[0], title: m[2].trim(), confidence: m[3] })
  }
  return out
}

/** 归一化:去空白/标点/符号,小写 — 容忍模型对标题的轻度改写与全半角差异。 */
function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * #756 citations 的 label 带装饰前缀(📖 标题 / 📄 文档名 / 📌 标题 /
 * 🧠 相关事实)— 统一剥离,取纯标题参与对账匹配。
 */
export function titlesFromCitationLabels(labels: string[]): string[] {
  return labels
    .map((l) => l.replace(/^[\s📌📍🔖📎📚🧠📖📄💡☑️✔✅]*[-–—]?\s*/u, '').trim())
    .filter((t) => t.length > 0)
}

export function auditMemoryCitations(text: string, injectedTitles: string[]): CitationAuditResult {
  const markers = extractCitationMarkers(text)
  if (markers.length === 0) {
    return { total: 0, verified: 0, unverified: [], annotatedText: text }
  }

  const pool = [...new Set(injectedTitles.map(normalizeTitle))].filter((t) => t.length >= 4)
  const match = (title: string): boolean => {
    const n = normalizeTitle(title)
    if (n.length < 4) return false
    if (pool.includes(n)) return true
    // 轻度改写容忍:标题被模型截断/扩写时按双向包含匹配(短边需 ≥6 字符,
    // 避免"研究"这类泛词误命中)。
    return pool.some((p) => (p.includes(n) || n.includes(p)) && Math.min(p.length, n.length) >= 6)
  }

  const unverified: Array<{ raw: string; title: string }> = []
  const annotatedText = text.replace(MARKER_RE, (full, _lp, title) => {
    if (match(String(title))) return full
    const t = String(title).trim()
    unverified.push({ raw: full, title: t })
    // 降级:保留模型所引标题但剥掉伪造置信度,加"未溯源"硬标注
    return `（来源：《${t}》，未溯源 — 该引用未命中本轮注入的知识库条目，不作为已核实依据）`
  })

  return { total: markers.length, verified: markers.length - unverified.length, unverified, annotatedText }
}
