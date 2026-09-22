/**
 * #1083: 结构化文献引用（DocCitation）契约 — 正式参考文献的唯一事实源形状。
 *
 * 与「参考材料池」（DocReference / ReferenceItem，上传 PDF/URL/粘贴文本的
 * 写作背景素材）在架构上隔离：正式参考文献必须来自文献检索（PubMed /
 * Crossref）且强制携带 DOI，上传素材永远不能成为正式引用。
 */
import { z } from 'zod'

/** DOI 格式：`10.` 前缀 + 4~9 位注册机构码 + `/` + 非空后缀（Crossref 全小写惯例不强制）。 */
export const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/

export const docCitationSchema = z.object({
  id: z.string().min(1).max(64),
  docId: z.string().min(1).max(64),
  doi: z.string().regex(DOI_PATTERN, 'doi must match ^10\\.\\d{4,9}/\\S+$'),  pmid: z.string().max(32).optional(),
  title: z.string().min(1).max(2000),
  /** JSON 序列化的作者数组（["Zhang S","Li Q"]），与 prisma String 列对齐。 */
  authors: z.string().max(16000),
  journal: z.string().max(500).optional(),
  year: z.number().int().min(1400).max(2100).optional(),
  url: z.string().max(2000).optional(),
  source: z.enum(['pubmed', 'crossref']),
})

export type DocCitation = z.infer<typeof docCitationSchema>

/**
 * 复审 #8: HTTP wire 形状 — 与 server-ts citation-store.serializeDocCitation
 * 的【实际回包】逐字段对齐（勿按 docCitationSchema 的存储形状臆测）。
 * 与存储形状（docCitationSchema）的差异全部收敛在此单一类型，各端一律
 * import 本类型，禁止手写第二份：
 *  - authors: DB 列存 JSON 字符串，序列化边界已反序列化为 string[]
 *    （坏 JSON 容错为空数组）；
 *  - createdAt: prisma 行时间戳（schema 是用户输入形状，不含该字段）；
 *  - 可空列（pmid/journal/year/url）在 wire 上显式 null（行值直通）；
 *  - docId 放宽为可选：列表/徽标等消费方常只按 id 局部构造。
 */
export type DocCitationWire = Omit<DocCitation, 'docId' | 'authors' | 'pmid' | 'journal' | 'year' | 'url'> & {
  docId?: string
  authors: string[]
  pmid?: string | null
  journal?: string | null
  year?: number | null
  url?: string | null
  createdAt?: string
}

/**
 * 复审 #8: docCitationSchema 形状（authors 为 JSON 字符串列）→ wire 形状
 * 的单一序列化实现 — authors 解析语义（坏 JSON 容错为空数组）与 server-ts
 * citation-store.serializeDocCitation 保持一致。
 */
export function serializeDocCitationWire(
  citation: Omit<DocCitation, 'docId'> & { docId?: string; createdAt?: string },
): DocCitationWire {
  let authors: string[] = []
  try {
    const parsed: unknown = JSON.parse(citation.authors || '[]')
    if (Array.isArray(parsed)) authors = parsed.map(String)
  } catch {
    // 容错：坏 JSON 视为空作者列表
  }
  return {
    id: citation.id,
    docId: citation.docId,
    doi: citation.doi,
    pmid: citation.pmid ?? null,
    title: citation.title,
    authors,
    journal: citation.journal ?? null,
    year: citation.year ?? null,
    url: citation.url ?? null,
    source: citation.source,
    createdAt: citation.createdAt,
  }
}

export function isValidDoi(doi: string): boolean {
  return DOI_PATTERN.test(doi.trim())
}

/** #1099/#1077/#1079 共用：正文引用 shortcode 格式。 */
export const CITE_SHORTCODE_PATTERN = /\[cite:([A-Za-z0-9_-]+)\]/g
export const CITE_SHORTCODE_SINGLE = /^[A-Za-z0-9_-]+$/

/**
 * #1099: 引用编号算法的单一实现 — 按 citationId 在正文中**首次出现**的顺序
 * 编号（同一 id 多次出现共享同一编号）。三处消费方（web 在线渲染 #1077、
 * References 列表 #1079、worker 导出 #1099）必须调用同一函数，禁止各自实现。
 */
export function assignCitationNumbers(body: string): Map<string, number> {
  const numbers = new Map<string, number>()
  let next = 1
  for (const match of body.matchAll(CITE_SHORTCODE_PATTERN)) {
    const id = match[1]
    if (!numbers.has(id)) numbers.set(id, next++)
  }
  return numbers
}

/** #1099: 未知 citationId 的导出占位标记（不静默丢弃、不原样保留内部 ID）。 */
export const CITATION_DANGLING_PLACEHOLDER = '[?]'

/**
 * #1099: 把正文中的 `[cite:id]` shortcode 解析为 `[n]` 编号文本。
 * 悬挂引用（不在 citations 表中的 id）替换为 `[?]` 占位并记入 dangling 返回值，
 * 供调用方（worker 导出）打日志告警。
 */
export function resolveCitationShortcodes(
  body: string,
  knownIds: ReadonlySet<string>,
): { text: string; dangling: string[] } {
  const numbers = assignCitationNumbers(body)
  const dangling: string[] = []
  const text = body.replace(CITE_SHORTCODE_PATTERN, (_m, id: string) => {
    if (!knownIds.has(id)) {
      dangling.push(id)
      return CITATION_DANGLING_PLACEHOLDER
    }
    return `[${numbers.get(id)}]`
  })
  return { text, dangling: [...new Set(dangling)] }
}
