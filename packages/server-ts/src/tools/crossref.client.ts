/**
 * #836 — Crossref client:DOI→规范元数据(Citation 形状,设计 L733
 * `source:'doi'`)+ 题名模糊检索(反查 DOI)。
 *
 * api.crossref.org 免费无 key,`?mailto=` 进 polite pool(#835 统一管道:
 * per-host 节流 + 24h 缓存 + 退避)。消费方:#807 引用纪律(search_citation
 * 的 Crossref fallback,补 preprint / 非 MEDLINE 期刊盲区)、
 * fetch_article_summary 的 DOI 直解、#382 选刊元数据。
 */
import { externalRequest, ExternalHttpError } from './external-fetch.js'
import { formatAma, type CitationRecord } from './search-citation-tool.js'

/** DOI 归一化:剥 URL/`doi:` 前缀与空白 — 模型常把 DOI 带着前缀复制进来。 */
export function normalizeDoi(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi\s*[:：]\s*/i, '')
    .trim()
}

/** 宽松 DOI 形状校验(10.前缀 + 后缀) — 工具入参防护用,不做严格语法解析。 */
export function looksLikeDoi(input: string): boolean {
  return /^10\.\d{4,9}\/\S+$/.test(normalizeDoi(input))
}

function stripJats(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function yearOf(msg: any): string {
  const parts = msg?.issued?.['date-parts']?.[0]
  const y = Array.isArray(parts) ? parts[0] : undefined
  return y ? String(y) : ''
}

function mapWork(msg: any): CitationRecord {
  const authors = Array.isArray(msg?.author)
    ? msg.author
        .map((a: any) => [a.family, a.given].filter(Boolean).join(' ').trim())
        .filter(Boolean)
    : []
  const record = {
    pmid: '',
    title: String(Array.isArray(msg?.title) ? msg.title[0] : msg?.title || '').replace(/\.$/, ''),
    authors,
    journal: String(Array.isArray(msg?.['container-title']) ? msg['container-title'][0] : msg?.['container-title'] || ''),
    year: yearOf(msg),
    volume: String(msg?.volume || ''),
    pages: String(msg?.page || ''),
    doi: String(msg?.DOI || ''),
    url: String(msg?.resource?.primary?.URL || (msg?.DOI ? `https://doi.org/${msg.DOI}` : '') || ''),
    abstract: msg?.abstract ? stripJats(String(msg.abstract)).slice(0, 2000) : undefined,
  }
  return { ...record, ama: formatAma(record) }
}

/**
 * 单 DOI 直解 → 规范 Citation。DOI 不存在/形式错误返回 null(404)。
 * 复用 #835 管道:polite pool + 24h 缓存 + 退避。
 */
export async function crossrefResolveDoi(doi: string): Promise<CitationRecord | null> {
  const norm = normalizeDoi(doi)
  if (!looksLikeDoi(norm)) return null
  let text: string
  try {
    text = await externalRequest('crossref', `/works/${encodeURIComponent(norm)}`)
  } catch (err) {
    // 404 → DOI 不存在(正常业务分支);其余错误上抛由调用方降级。
    if (err instanceof ExternalHttpError && err.status === 404) return null
    throw err
  }
  const msg = JSON.parse(text)?.message
  return msg ? mapWork(msg) : null
}

/** 题名模糊检索(query.bibliographic)→ Citation 列表。 */
export async function crossrefSearchBibliographic(query: string, rows: number): Promise<CitationRecord[]> {
  const text = await externalRequest('crossref', '/works', {
    'query.bibliographic': query,
    rows: String(Math.min(Math.max(rows, 1), 8)),
    select: 'DOI,title,author,container-title,issued,volume,page,abstract,resource',
  })
  const items = JSON.parse(text)?.message?.items
  return Array.isArray(items) ? items.map(mapWork) : []
}

/** Crossref 记录 → fetch_article_summary 输出文本(与 PubMed 输出形状对齐)。 */
export function formatCrossrefSummary(r: CitationRecord): string {
  return [
    `Title: ${r.title}`,
    `Journal: ${r.journal}${r.year ? ` (${r.year})` : ''}`,
    `Authors: ${r.authors.join(', ') || 'n/a'}`,
    `PMID: n/a | DOI: ${r.doi}`,
    'Source: Crossref',
    '',
    'Abstract:',
    r.abstract || 'No abstract available (Crossref 元数据不含摘要 — 需要摘要请用 pmid 走 PubMed)',
  ].join('\n')
}
