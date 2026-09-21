import { BaseTool, ToolResult } from './base-tool.js'
import type { ToolContext } from './tool-registry.js'
import { parseDocSessionId } from './tool-registry.js'
import { resetEutilsState, pubmedSearchRecords, type CitationRecord } from './search-citation-tool.js'
import { crossrefSearchBibliographic } from './crossref.client.js'
import { resolveOrCreateDocCitation } from '../lib/citation-store.js'

/**
 * #1076 — insert_citation: 正式引用（DocCitation）的唯一写入工具。
 *
 * 与 search_citation 的分工：search_citation 只做检索核实（只读），
 * 本工具走同一检索管道（PubMed esearch/esummary 优先，Crossref 题名检索
 * 兜底，复用 #835 节流/缓存/退避）后把**带 DOI 的第一条命中**经
 * citation-store.resolveOrCreateDocCitation 落为正式引用，返回
 * `[cite:<citation_id>]` 稳定标记 — 模型用 edit_document 把标记插入
 * 正文，References 列表由导出边界 #1078 自动生成，**严禁手写**。
 *
 * 架构隔离（epic #1084 C4）：本文件不接触参考材料池（上传素材）相关模块
 * — 正式引用只来自文献检索且强制 DOI，入库由 citation-store
 * 单点把关（isValidDoi 双锁 + [docId,doi] 幂等）。
 */

/** 测试钩子:重置节流阀与缓存(委托统一管道,与 search_citation 同面)。 */
export function resetInsertCitationState(): void {
  resetEutilsState()
}

export interface InsertCitationMetadata {
  citation_id: string
  doi: string
  title: string
  journal?: string | null
  year?: number | null
  pmid?: string | null
  source: 'pubmed' | 'crossref'
}

export class InsertCitationTool extends BaseTool {
  constructor(private ctx: ToolContext) {
    super()
  }

  get name(): string { return 'insert_citation' }

  get description(): string {
    return [
      'Create an official, DOI-backed citation from REAL literature search (PubMed first, Crossref fallback) and return a stable marker `[cite:<citation_id>]`.',
      'Flow: call this tool with a search query, then insert the returned `[cite:<citation_id>]` marker into the document body at the exact reference point via edit_document (old_text/new_text or section edit).',
      'NEVER hand-write reference entries, numbered lists like [1][2], or a References section — the References list is generated automatically at export from the citation store.',
      'If no DOI-backed result is found the citation is NOT created and nothing may be invented (no fabricated DOI/PMID/authors/years).',
      'search_citation remains available for verification/reading, but its raw output must never be pasted into the document as citation text.',
    ].join(' ')
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Citation search query — topic, title keywords, author, or combination (e.g. "EGFR mutant NSCLC pembrolizumab real-world"). The first DOI-bearing hit becomes the citation.' },
      },
      required: ['query'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query) return { success: false, error: 'query is required' }

    // #1076: 正式引用挂在文档上 — 非 doc- 会话无归属，直接拒绝。
    const docId = parseDocSessionId(this.ctx.sessionId)
    if (!docId) {
      return { success: false, error: 'insert_citation requires a document session (doc-{docId})' }
    }

    // 检索管道与 search_citation 同源：PubMed 优先 → Crossref 兜底（#835 管道）。
    let record: CitationRecord | null = null
    let source: 'pubmed' | 'crossref' = 'pubmed'
    try {
      const hits = await pubmedSearchRecords(query, 5)
      record = hits.find((c) => Boolean(c.doi)) ?? null
      if (record) source = 'pubmed'
    } catch {
      // PubMed 失败 → 降级 Crossref（与 search_citation 同纪律，错误不吞给模型之外的层）。
    }
    if (!record) {
      try {
        const crossrefHits = await crossrefSearchBibliographic(query, 5)
        record = crossrefHits.find((c) => Boolean(c.doi)) ?? null
        if (record) source = 'crossref'
      } catch {
        // 双源均失败 → 走 no_doi_found 分支如实报错。
      }
    }

    // FILTER：无 DOI 命中一律丢弃 — 正式引用必须 DOI 背书（store 层同样双锁）。
    if (!record || !record.doi) {
      return {
        success: false,
        error: 'no_doi_found: 检索未找到带 DOI 的真实文献，引用未创建 — 如实告知用户即可，严禁编造 DOI/PMID/作者/年份，也不要把无 DOI 的检索结果写成正式引用。',
      }
    }

    // 落库单点：citation-store 双锁校验 + (docId, doi) 幂等（同 DOI 重复调用复用同一行）。
    const row = await resolveOrCreateDocCitation({
      docId,
      doi: record.doi,
      pmid: record.pmid || null,
      title: record.title || query,
      authors: record.authors ?? [],
      journal: record.journal || null,
      year: record.year ? Number(record.year) || null : null,
      url: record.url || null,
      source,
    })

    const meta: InsertCitationMetadata = {
      citation_id: row.id,
      doi: row.doi,
      title: row.title,
      journal: row.journal,
      year: row.year,
      pmid: row.pmid,
      source: row.source as 'pubmed' | 'crossref',
    }
    // #1076: output 同时承载人类可读说明 + 结构化 JSON — 模型必须学到
    // [cite:id] 标记的用法（插正文、不手写 References）。
    const output = JSON.stringify({
      ...meta,
      marker: `[cite:${row.id}]`,
      instructions: `引用已创建（来源 ${source}，DOI ${row.doi}）。请用 edit_document 把标记 [cite:${row.id}] 原样插入正文中引用该文献的位置（old_text/new_text 或节编辑均可）；不要手写编号（[1][2]）、不要手写文献条目、不要手写 References 列表 — 导出时系统会按正文首现顺序自动生成 References。`,
    })
    return { success: true, output }
  }
}
