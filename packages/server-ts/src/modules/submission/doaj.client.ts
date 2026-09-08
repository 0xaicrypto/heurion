/**
 * #852 — DOAJ client:ISSN → OA 状态/APC 费用/许可。
 * apc 记录 DOAJ 原币种(不做汇率换算 — 假装精确换算等于伪造数据)。
 * 2026-09-08 实测对齐:现行 API 的 apc 为 { has_apc, max: [{price, currency}] } 结构
 * (旧版 average_price 字段保留兼容解析);取价优先 USD,否则取首项原币种。
 */
import { externalRequest } from '../../tools/external-fetch.js'

export interface DoajJournalInfo {
  inDoaj: boolean
  title?: string
  apc?: { value: number; currency: string }
  license?: string
  asOf: string
}

interface RawBibjson {
  title?: string
  apc?: {
    has_apc?: boolean
    max?: Array<{ price?: number; currency?: string }>
    currency?: string
    average_price?: number
  }
  license?: Array<{ type?: string }>
}

interface RawSearchResult {
  results?: Array<{ bibjson?: RawBibjson }>
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function parseApc(apc: NonNullable<RawBibjson['apc']>): { value: number; currency: string } | undefined {
  const entries = (apc.max ?? []).filter((m) => typeof m.price === 'number' && m.price > 0 && m.currency)
  if (entries.length > 0) {
    const usd = entries.find((m) => m.currency === 'USD')
    const pick = usd ?? entries[0]
    return { value: pick.price as number, currency: pick.currency as string }
  }
  // 旧版字段兼容
  if (typeof apc.average_price === 'number' && apc.average_price > 0 && apc.currency) {
    return { value: apc.average_price, currency: apc.currency }
  }
  return undefined
}

/**
 * 按 ISSN 查 DOAJ 期刊。未收录(results 空)→ { inDoaj: false }。
 * 网络错误向上抛,由 repository 兜底 seed 快照。
 */
export async function fetchDoajJournal(issn: string): Promise<DoajJournalInfo> {
  const raw = await externalRequest('doaj', `/api/search/journals/issn:${encodeURIComponent(issn)}`)
  const data = JSON.parse(raw) as RawSearchResult
  const bib = data.results?.[0]?.bibjson
  if (!bib) return { inDoaj: false, asOf: today() }
  return {
    inDoaj: true,
    title: bib.title,
    apc: bib.apc ? parseApc(bib.apc) : undefined,
    license: bib.license?.[0]?.type,
    asOf: today(),
  }
}
