import { BaseTool, ToolResult } from './base-tool.js'
import type { ToolContext } from './tool-registry.js'
import { externalRequest } from './external-fetch.js'
import { crossrefResolveDoi, looksLikeDoi, normalizeDoi } from './crossref.client.js'

/**
 * #837 — oa_pdf_lookup:Unpaywall + Crossref combo 的 OA 全文获取。
 *
 * 设计 L706 `oa_pdf_lookup(doi) → Optional[OaUrl]`,Tier J2 "我要读全文":
 *  - OA 命中 → Unpaywall `best_oa_location.url_for_pdf`(license 标注),
 *    可经 edit_document 的 import_reference url 参数直接入库(#875);
 *  - OA 无直接 PDF → 开放落地页 URL;
 *  - 非 OA / Unpaywall 失败 → Crossref 兜底出版社直链,只展示
 *    "open at publisher",**不缓存也不绕过付费墙**(设计 L754 合规红线)。
 *
 * 滥用指引:本工具只做元数据级 DOI 查询,不抓取付费正文;批量抓取请尊重
 * polite pool(#835 管道已内置 per-host 限速与 24h 缓存)。
 */
/**
 * #875: OA 归属校验 — URL 是否属于该 DOI 的 Unpaywall 开放获取位置。
 * 返回 true(在 OA 集合)/ false(明确不在 — 疑似付费墙,调用方拒绝入库)/
 * null(无法验证:Unpaywall 不可达/无记录/DOI 形式不合法 — 调用方 best-effort 放行)。
 * Unpaywall 走 externalRequest(24h 缓存),同一 DOI 的重复校验零上游调用。
 */
export async function isOaUrlForDoi(doi: string, url: string): Promise<boolean | null> {
  try {
    const norm = normalizeDoi(doi)
    if (!looksLikeDoi(norm)) return null
    const email = process.env.UNPAYWALL_EMAIL || process.env.CROSSREF_MAILTO
    const text = await externalRequest('unpaywall', `/v2/${encodeURIComponent(norm)}`, email ? { email } : {})
    const data = JSON.parse(text)
    const candidates = new Set<string>()
    const add = (u: unknown) => {
      if (typeof u === 'string' && u) candidates.add(u.trim().replace(/\/+$/, ''))
    }
    add(data?.best_oa_location?.url_for_pdf)
    add(data?.best_oa_location?.url)
    add(data?.url)
    for (const loc of data?.oa_locations || []) {
      add(loc?.url_for_pdf)
      add(loc?.url)
    }
    if (candidates.size === 0) return null
    const target = url.trim().replace(/\/+$/, '')
    if (candidates.has(target)) return true
    // URL 变体(查询参数/token 差异)— 去查询串后前缀比对
    const bare = target.split('?')[0].replace(/\/+$/, '')
    for (const c of candidates) {
      if (c === bare || c.split('?')[0] === bare) return true
    }
    return false
  } catch {
    return null
  }
}

export class OaPdfLookupTool extends BaseTool {
  constructor(_ctx: ToolContext) {
    super()
  }

  get name(): string { return 'oa_pdf_lookup' }

  get description(): string {
    return [
      'Look up an Open-Access full text for a DOI (Unpaywall first, Crossref publisher link as fallback).',
      'Returns a downloadable PDF URL for OA papers, or the publisher page ("open at publisher, institutional access required") for paywalled ones — never bypasses paywalls.',
      'OA PDFs can be imported into the reference library via import_reference.',
      'Use when the user wants to READ the full text of a verified citation (search_citation / fetch_article_summary first to verify the DOI).',
    ].join(' ')
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        doi: { type: 'string', description: 'DOI of the article, e.g. "10.1056/NEJMoa2004416". Must come from a real search hit — never invent a DOI.' },
      },
      required: ['doi'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const norm = normalizeDoi(String(args.doi || ''))
    if (!looksLikeDoi(norm)) {
      return { success: false, error: `DOI 形式不合法: ${String(args.doi || '').slice(0, 80)} — 应形如 10.1056/NEJMoa2004416,且必须来自真实检索命中,禁止编造。` }
    }

    // ── Unpaywall(单独可达:Crossref 不可用不影响本路径) ──
    try {
      // Unpaywall 要求 email 参数(#837:UNPAYWALL_EMAIL,缺省复用 CROSSREF_MAILTO)。
      const email = process.env.UNPAYWALL_EMAIL || process.env.CROSSREF_MAILTO
      const text = await externalRequest('unpaywall', `/v2/${encodeURIComponent(norm)}`, email ? { email } : {})
      const data = JSON.parse(text)
      if (data?.is_oa) {
        const loc = data.best_oa_location || {}
        const license = loc.license ? `license: ${loc.license}` : 'license: unspecified'
        if (loc.url_for_pdf) {
          return {
            success: true,
            output: `开放获取全文 PDF（Unpaywall，${license}）：\n${loc.url_for_pdf}\n\n可将该 URL 经 edit_document 的 import_reference 的 url 参数直接入库(下载 OA 全文 → 参考材料 → 导入正文;带 doi 参数可自动校验 OA 归属)。`,
          }
        }
        const landing = loc.url || data.url
        if (landing) {
          return {
            success: true,
            output: `该论文为开放获取（${license}），但无直接 PDF 链接 — 开放落地页：\n${landing}\n\n若落地页含可直接下载的 OA PDF 直链,可将该 URL 经 edit_document 的 import_reference 的 url 参数入库;否则建议用户手动下载后上传。`,
          }
        }
      }
    } catch { /* Unpaywall 失败 → Crossref 兜底 */ }

    // ── Crossref 兜底:出版社直链(只展示,不缓存正文,不绕付费墙) ──
    try {
      const cr = await crossrefResolveDoi(norm)
      if (cr) {
        return {
          success: true,
          output: `未找到开放获取全文（或 Unpaywall 暂不可用）— 出版社直链（open at publisher, institutional access required）：\n${cr.url || `https://doi.org/${norm}`}\n\n本工具不缓存付费正文、不绕过付费墙；有机构订阅权限可在浏览器打开后手动导入参考材料。`,
        }
      }
      return { success: false, error: `Crossref 无该 DOI 记录: ${norm} — 请先用 search_citation 确认 DOI 真实存在，禁止编造。` }
    } catch (err) {
      return { success: false, error: `oa_pdf_lookup 失败: ${(err as Error).message.slice(0, 160)} — 可改用 fetch_article_summary 获取元数据，禁止编造 PDF 链接。` }
    }
  }
}
