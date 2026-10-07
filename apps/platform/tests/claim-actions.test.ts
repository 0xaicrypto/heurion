import { describe, expect, it } from 'vitest'
import { ClaimService } from '../src/claims/service.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { Store } from '../src/store/db.ts'
import { buildApi } from '../src/http/api.ts'
import { TurnService } from '../src/turns/service.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Accounts } from '../src/auth/accounts.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

describe('论断核对临床闭环 (Claim Actions & Exemption)', () => {
  it('store.exemptClaim：将论断标记为豁免，关闭关联评论且后续核对不再重复报错', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const doc = docs.create({ owner: 'u1', title: '心血管研究' })
    const claimService = new ClaimService(docs, {} as PubMedClient)
    const ops = new OpService(docs)

    const cite = store.upsertCitation({ doc_id: doc.id, doi: '10.1056/nejmoa2307563', pmid: null, formatted: 'SELECT. NEJM 2023.', url: null })
    const p1 = docs.get(doc.id).child(0).attrs.id as string
    ops.edit({
      doc_id: doc.id,
      base_rev: 0,
      mode: 'apply',
      ops: [{ op: 'replace_block', id: p1, markdown: `在临床试验中将尿白蛋白降低 15%[@c:${cite.id}]。` }],
    }, { actor: 'user', turnId: null })

    const ev = await claimService.evidence(doc.id)
    const claim = ev.claims[0]!
    expect(claim).toBeDefined()

    // 写入一个有出处问题的论断记录与关联评论
    const row = store.addComment({ doc_id: doc.id, node_id: claim.node_id, snippet: '降低 15%' })
    store.putClaimCheck({
      doc_id: doc.id,
      claim_id: claim.claim_id,
      node_id: claim.node_id,
      sentence: claim.sentence,
      verdict: 'unsupported',
      reason: '文献明确为降低 30%，非 15%。【建议修改为】：降低 30%',
      comment_id: row.id,
      rev: 0,
    })

    // 医生标记为临床经验豁免
    store.exemptClaim(doc.id, claim.claim_id, '结合本科室真实世界队列观察')
    const check = store.getClaimCheck(doc.id, claim.claim_id)
    expect(check?.verdict).toBe('exempted')
    expect(check?.reason).toContain('结合本科室真实世界队列观察')

    // 关联评论已被自动关闭
    const comments = store.listComments(doc.id)
    expect(comments[0]!.status).toBe('resolved')
    expect(comments[0]!.replies.some(r => r.text.includes('临床经验豁免'))).toBe(true)

    // 模拟新一轮回合再次提交 unsupported，已被豁免的论断保持 unchanged，不新建警告评论
    const res = claimService.report(doc.id, [{ claim_id: claim.claim_id, verdict: 'unsupported', reason: '仍然与文献矛盾' }])
    expect(res[0]?.status).toBe('unchanged')
  })

  it('HTTP API：POST /api/docs/:id/comments/:cid/apply-claim-fix 一键采纳建议并更新正文', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const doc = docs.create({ owner: 'u1', title: '试验总结' })
    const ops = new OpService(docs)
    const turns = new TurnService(docs, {} as HarnessPool, new TurnRegistry())
    const postcheck = new PostCheck(docs)
    const accounts = new Accounts(store, { secret: 's', devMode: true, devToken: 'dev-token', devUser: 'u1' })

    const app = buildApi({
      docs, ops, turns, postcheck, crossref: {} as CrossrefClient,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'claim-fix-'))),
      accounts, devMode: true, devUser: 'u1',
    })

    // 正文写入一个待修正数字
    const p1 = docs.get(doc.id).child(0).attrs.id as string
    ops.edit({
      doc_id: doc.id,
      base_rev: 0,
      mode: 'apply',
      ops: [{ op: 'replace_block', id: p1, markdown: '试验结果显示尿蛋白降低 15%。' }],
    }, { actor: 'user', turnId: null })

    // 添加一条带修复建议的评论
    const comment = store.addComment({ doc_id: doc.id, node_id: p1, snippet: '降低 15%' })
    store.addReply(comment.id, 'ai', '论断核对：所引文献不支持该论断。文献明确显示降低 30%。\n【建议修改为】：降低 30%')

    // 调用一键采纳建议接口
    const res = await app.request(`/api/docs/${doc.id}/comments/${comment.id}/apply-claim-fix`, {
      method: 'POST',
      headers: { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    const resText = await res.text()
    expect(res.status).toBe(200)
    const body = JSON.parse(resText)
    expect(body.ok).toBe(true)
    expect(body.replaced).toEqual({ find: '降低 15%', replace: '降低 30%' })

    // 正文已被修改为 30%
    const updated = docs.get(doc.id).child(0).textContent
    expect(updated).toContain('降低 30%')

    // 评论已被关闭并记录回复
    const c = store.getComment(doc.id, comment.id)
    expect(c?.status).toBe('resolved')
    expect(c?.replies.some(r => r.text.includes('已将「降低 15%」替换为「降低 30%」'))).toBe(true)
  })
})
