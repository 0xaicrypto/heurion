import { BaseTool, ToolResult } from './base-tool.js'
import type { ToolContext } from './tool-registry.js'
import { externalRequest, resetExternalFetchState } from './external-fetch.js'
import { crossrefSearchBibliographic } from './crossref.client.js'

/**
 * #807 — search_citation: 引用实体化第一块。学术写作零容忍编造：References
 * 里的 PMID/年份/作者必须来自真实检索。本工具直连 PubMed E-utilities
 * （esearch → esummary），返回 AMA 格式引用串 + 结构化元数据。
 * 与 search_medical_web 的区别：本工具输出**引用级**元数据（可进
 * References），不做全文/摘要检索。
 *
 * #835: 生产实测写作回合每轮并行 3 个查询 × 连续 5 轮 → NCBI 无 key 限
 * 3 req/s → HTTP 429 大面积失败(检索/读取 折叠组全红)。对策:
 * ① 全局节流阀(无 key 400ms/请求 ≈2.5 req/s;配 NCBI_API_KEY 后 120ms);
 * ② 429/5xx 退避重试一次(尊重 Retry-After);
 * ③ 5 分钟请求缓存 — 模型同回合重复相似查询不再烧配额。
 */
/** 测试钩子:重置节流阀与缓存(委托统一管道)。 */
export function resetEutilsState(): void {
  resetExternalFetchState()
}

/** #837: 统一 eutils 出口 — 主/写作 chat 的所有 PubMed 检索都过同一节流阀。 */
async function eutilsJson(path: string, params: Record<string, string>): Promise<any> {
  return JSON.parse(await eutilsRequest(path, params))
}

export interface EutilsRequestOptions { signal?: AbortSignal }

/**
 * #837: E-utilities 统一请求管道(api_key + 进程级节流阀 + 5min 缓存 +
 * 429/5xx 退避重试一次)。#835: 实现委托给 external-fetch 统一管道
 * (per-host 节流/缓存/退避),eutils 调用面语义不变 — 返回原始响应文本。
 */
export async function eutilsRequest(
  path: string,
  params: Record<string, string>,
  opts: EutilsRequestOptions = {},
): Promise<string> {
  return externalRequest('eutils', path, params, opts)
}

export interface CitationRecord {
  pmid: string
  title: string
  authors: string[]
  journal: string
  year: string
  volume?: string
  pages?: string
  doi?: string
  /** #836: Crossref 记录附字段(设计 L733 Citation 形状)。 */
  url?: string
  abstract?: string
  /** AMA 格式（作者 ≤3 全列,>3 前三+et al.） */
  ama: string
}

export function formatAma(r: Omit<CitationRecord, 'ama'>): string {
  const a = r.authors.filter(Boolean)
  const authors = a.length === 0 ? '' : a.length <= 3 ? `${a.join(', ')}.` : `${a.slice(0, 3).join(', ')}, et al.`
  const doi = r.doi ? (r.pmid ? ` doi: ${r.doi}` : ` doi: ${r.doi}.`) : ''
  // #836: Crossref 记录无 PMID — 只有存在时输出,AMA 串保持可核对。
  const pmid = r.pmid ? ` PMID: ${r.pmid}.` : ''
  return `${authors} ${r.title}. ${r.journal}. ${r.year}${r.volume ? `;${r.volume}` : ''}${r.pages ? `:${r.pages}` : ''}.${doi}${pmid}`
}


export class SearchCitationTool extends BaseTool {
  constructor(_ctx: ToolContext) {
    super()
  }

  get name(): string { return 'search_citation' }

  get description(): string {
    return [
      'Search PubMed for REAL, verifiable citations (PMID/authors/year/journal/DOI) and get AMA-formatted reference strings.',
      '#836: when PubMed has no hit, automatically falls back to a Crossref bibliographic search — covers preprints and non-MEDLINE journals (DOI-backed, no PMID).',
      'Use this EVERY time you add or edit references/citations in a document — NEVER invent PMID, authors, years or DOIs.',
      'If no result matches, say so honestly instead of fabricating. Returns up to 8 citations per query.',
    ].join(' ')
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Citation search query — topic, title keywords, author, or combination (e.g. "EGFR mutant NSCLC pembrolizumab real-world").' },
        retmax: { type: 'number', description: 'Max citations to return (default 5, max 8).' },
      },
      required: ['query'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query) return { success: false, error: 'query is required' }
    const retmax = Math.min(Math.max(Number(args.retmax) || 5, 1), 8)

    let citations: CitationRecord[] = []
    let pubmedError: string | null = null
    try {
      const search = await eutilsJson('esearch.fcgi', { db: 'pubmed', term: query, retmode: 'json', retmax: String(retmax), sort: 'relevance' })
      const ids: string[] = search?.esearchresult?.idlist ?? []
      if (ids.length > 0) {
        const summary = await eutilsJson('esummary.fcgi', { db: 'pubmed', id: ids.join(','), retmode: 'json' })
        const docs = summary?.result ?? {}
        citations = ids
          .filter((pmid) => docs[pmid])
          .map((pmid) => {
            const d = docs[pmid]
            const record = {
              pmid,
              title: String(d.title || '').replace(/\.$/, ''),
              authors: Array.isArray(d.authors) ? d.authors.map((a: any) => String(a.name || '')).filter(Boolean) : [],
              journal: String(d.fulljournalname || d.source || ''),
              year: String(d.pubdate || '').slice(0, 4) || '',
              volume: String(d.volume || ''),
              pages: String(d.pages || ''),
              doi: (Array.isArray(d.summaryids) ? d.summaryids.find((x: any) => x.idtype === 'doi')?.value : '') || undefined,
            }
            return { ...record, ama: formatAma(record) }
          })
      }
    } catch (err) {
      pubmedError = (err as Error).message.slice(0, 160)
    }

    if (citations.length > 0) {
      const body = citations.map((c, i) => `${i + 1}. ${c.ama}`).join('\n')
      const output = `共 ${citations.length} 条真实引用（可直接用于 References，格式 AMA）：\n${body}\n\n提醒：只能引用以上检索到的文献；写进文档时保留 PMID 以便核对。`
      return { success: true, output }
    }

    // #836: PubMed 无命中/失败 → Crossref 题名检索补盲区(preprint/非 MEDLINE)。
    let crossrefError: string | null = null
    try {
      citations = await crossrefSearchBibliographic(query, retmax)
    } catch (err) {
      crossrefError = (err as Error).message.slice(0, 160)
    }
    if (citations.length > 0) {
      const body = citations.map((c, i) => `${i + 1}. ${c.ama}`).join('\n')
      const output = `PubMed 无命中，Crossref 补获 ${citations.length} 条真实引用（含 preprint / 非 MEDLINE 期刊，来源标注 Crossref，可直接用于 References，格式 AMA）：\n${body}\n\n提醒：只能引用以上检索到的文献；写进文档时保留 DOI 以便核对（Crossref 记录无 PMID）。禁止编造。`
      return { success: true, output }
    }

    // 双源均无产出 — 如实告知,零编造(#807 纪律)。
    const why = pubmedError
      ? `PubMed 检索失败(${pubmedError})`
      : 'PubMed 与 Crossref 均未找到匹配文献'
    const crNote = crossrefError ? `;Crossref 检索失败(${crossrefError})` : ''
    return {
      success: false,
      error: `${why}${crNote} — 请如实告知用户无法确认该引用，禁止编造。`,
    }
  }
}
