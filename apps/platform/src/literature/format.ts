import type { Article } from './types.ts'

/** 规范化 DOI：去前缀、转小写，便于去重与比对。 */
export function normalizeDoi(raw: string): string {
  return raw.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase()
}

/** AMA 格式：作者超过 6 位时列前 3 位 + et al。 */
export function formatAma(a: Article): string {
  const authors = a.authors.length > 6 ? `${a.authors.slice(0, 3).join(', ')}, et al` : a.authors.join(', ')
  const title = a.title.replace(/\.$/, '')
  let source = `${a.journal}. ${a.year}`
  if (a.volume) source += `;${a.volume}`
  if (a.issue) source += `(${a.issue})`
  if (a.pages) source += `:${a.pages}`
  const parts = [authors ? `${authors}.` : '', `${title}.`, `${source}.`]
  if (a.doi) parts.push(`doi:${a.doi}`)
  return parts.filter(Boolean).join(' ')
}
