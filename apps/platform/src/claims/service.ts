import { attachComment, AnchorError } from '../model/anchors.ts'
import type { Documents } from '../model/runtime.ts'
import type { PubMedClient } from '../literature/pubmed.ts'
import type { ClaimVerdict } from '../store/db.ts'
import { citationOrder } from '../views/read.ts'
import { extractClaims, type Claim } from './extract.ts'

/**
 * 论断核对（M1，PLATFORM.md §5.5）。分工：
 * - 平台：抽出带引用的句子与「缺出处」的数值句，为每条引用取 PubMed 摘要作为证据（缓存）；
 * - 调用方模型：逐条判断「支持 / 不支持 / 无法判断」，经 claim_report 提交；
 * - 平台：不支持、无法判断、缺出处的论断以 AI 评论挂到该句，由用户决定是否修改（不自动改写）。
 */

const PAGE = 8
const ABSTRACT_MAX = 1800

export interface ClaimEvidence {
  claim_id: string
  node_id: string
  sentence: string
  citations: Array<{ cite_id: string; number: number | null; reference: string; abstract: string | null }>
  last_verdict?: ClaimVerdict
}

export class ClaimService {
  constructor(private readonly docs: Documents, private readonly pubmed: PubMedClient) {}

  private extract(docId: string): { claims: Claim[]; unsourced: Claim[] } {
    const doc = this.docs.get(docId)
    const order = citationOrder(doc)
    return extractClaims(doc, new Map(order.map((id, i) => [id, i + 1])))
  }

  private async abstractFor(doi: string, pmid: string | null): Promise<string | null> {
    const cached = this.docs.store.getAbstract(doi)
    if (cached) return cached.abstract
    let id = pmid
    let abstract: string | null = null
    try {
      id ??= await this.pubmed.pmidForDoi(doi)
      abstract = id ? await this.pubmed.abstract(id) : null
    } catch {
      return null // 网络问题不缓存，下次再取
    }
    this.docs.store.putAbstract(doi, id, abstract)
    return abstract
  }

  /** 一页待核对的论断（带证据）+ 缺出处的数值句。 */
  async evidence(docId: string, cursor = 0): Promise<{ rev: number; claims: ClaimEvidence[]; unsourced: Array<{ claim_id: string; node_id: string; sentence: string }>; total: number; next_cursor: number | null }> {
    const { claims, unsourced } = this.extract(docId)
    const store = this.docs.store
    const cites = new Map(store.listCitations(docId).map(c => [c.id, c]))
    const order = citationOrder(this.docs.get(docId))
    const page = claims.slice(cursor, cursor + PAGE)
    const out: ClaimEvidence[] = []
    for (const c of page) {
      const citations = []
      for (const id of c.cite_ids) {
        const row = cites.get(id)
        if (!row) continue
        const abstract = await this.abstractFor(row.doi, row.pmid)
        citations.push({ cite_id: id, number: order.includes(id) ? order.indexOf(id) + 1 : null, reference: row.formatted, abstract: abstract ? abstract.slice(0, ABSTRACT_MAX) : null })
      }
      const last = store.getClaimCheck(docId, c.claim_id)?.verdict
      out.push({ claim_id: c.claim_id, node_id: c.node_id, sentence: c.sentence, citations, ...(last ? { last_verdict: last } : {}) })
    }
    const next = cursor + PAGE < claims.length ? cursor + PAGE : null
    return {
      rev: this.docs.rev(docId),
      claims: out,
      unsourced: cursor === 0 ? unsourced.map(u => ({ claim_id: u.claim_id, node_id: u.node_id, sentence: u.sentence })) : [],
      total: claims.length,
      next_cursor: next,
    }
  }

  /**
   * 记录核对结果；不支持 / 无法判断 / 缺出处 → 在该句挂 AI 评论（同一句同一结论不重复挂）。
   * 返回每条的处理结果。
   */
  report(docId: string, results: Array<{ claim_id: string; verdict: ClaimVerdict; reason: string }>): Array<{ claim_id: string; status: 'recorded' | 'commented' | 'unchanged' | 'stale'; comment_id?: string }> {
    const store = this.docs.store
    const { claims, unsourced } = this.extract(docId)
    const byId = new Map([...claims, ...unsourced].map(c => [c.claim_id, c]))
    const out: Array<{ claim_id: string; status: 'recorded' | 'commented' | 'unchanged' | 'stale'; comment_id?: string }> = []
    for (const r of results) {
      const claim = byId.get(r.claim_id)
      if (!claim) { out.push({ claim_id: r.claim_id, status: 'stale' }); continue }
      const prev = store.getClaimCheck(docId, r.claim_id)
      if (prev && prev.verdict === r.verdict && (r.verdict === 'supported' || prev.comment_id)) {
        out.push({ claim_id: r.claim_id, status: 'unchanged', ...(prev.comment_id ? { comment_id: prev.comment_id } : {}) })
        continue
      }
      let commentId: string | null = null
      if (r.verdict !== 'supported') commentId = this.comment(docId, claim, r.verdict, r.reason)
      store.putClaimCheck({ doc_id: docId, claim_id: r.claim_id, node_id: claim.node_id, sentence: claim.sentence, verdict: r.verdict, reason: r.reason, comment_id: commentId, rev: this.docs.rev(docId) })
      out.push({ claim_id: r.claim_id, status: commentId ? 'commented' : 'recorded', ...(commentId ? { comment_id: commentId } : {}) })
    }
    return out
  }

  private comment(docId: string, claim: Claim, verdict: ClaimVerdict, reason: string): string | null {
    const store = this.docs.store
    const label = { unsupported: '所引文献不支持该论断', unclear: '无法从所引文献判断', missing_citation: '数值型论断缺少出处', supported: '' }[verdict]
    const row = store.addComment({ doc_id: docId, node_id: claim.node_id, snippet: claim.snippet })
    try {
      const anchored = attachComment(this.docs.get(docId), claim.node_id, claim.snippet, row.id)
      this.docs.commit(docId, anchored.doc, { actor: 'system', turnId: null, ops: [{ op: 'claim_comment', thread: row.id }] })
    } catch (err) {
      if (!(err instanceof AnchorError)) throw err
      // 找不到锚定文字：退化为整块锚点
      store.db.prepare('UPDATE comments SET snippet = \'\' WHERE id = ?').run(row.id)
    }
    store.addReply(row.id, 'ai', `论断核对：${label}。${reason}\n句子：${claim.sentence}`)
    return row.id
  }
}

/** 「核对全部论断」回合的提示。 */
export function verifyPrompt(docId: string): string {
  return (
    `请核对文档 ${docId} 中带引用的论断，只核对、不修改正文：\n` +
    `1. 调用 verify_claims（doc_id="${docId}"），按 next_cursor 翻页直到取完；\n` +
    `2. 逐条对照所引文献的摘要判断：supported（摘要支持该句的说法与数字）/ unsupported（摘要与该句矛盾，或数字、结论、人群对不上）/ unclear（摘要信息不足以判断）；` +
    `unsourced 里的数值句判为 missing_citation；\n` +
    `3. 每页判断完就用 claim_report 提交，reason 用一两句话写明依据（引用摘要里的关键数字或结论）；\n` +
    `4. 最后用两三句话总结核对结果。`
  )
}
