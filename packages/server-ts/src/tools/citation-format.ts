/** #1146 循环依赖:引用记录形状 + AMA 格式化下沉叶子模块 —
 * crossref.client 与 search-citation-tool 互引成环,移到无依赖叶子。 */
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
