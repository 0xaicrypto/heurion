import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { issueToken, verifyToken } from '../src/auth/token.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { ClaimService } from '../src/claims/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { buildMcpServer } from '../src/mcp/server.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { setup } from './helpers.ts'

const SECRET = 'test-secret'

async function connect(markdown: string, scope: { d?: '*' | string[]; p?: Array<'read' | 'write'> } = {}) {
  const env = setup(markdown)
  const workspace = mkdtempSync(join(tmpdir(), 'heurion-ws-'))
  const registry = new TurnRegistry()
  const crossref = {
    lookup: async (doi: string) => doi.includes('404') ? null : { pmid: null, doi: doi.toLowerCase(), title: 'Trial', authors: ['Doe J'], journal: 'N Engl J Med', year: '2020' },
  } as unknown as CrossrefClient
  const claims = verifyToken(SECRET, issueToken(SECRET, { u: 'u1', d: scope.d ?? '*', p: scope.p ?? ['read', 'write'], aud: 'mcp', ttlSeconds: 60 }), 'mcp')!
  const pubmed = {
    search: async () => [],
    pmidForDoi: async () => '12345',
    abstract: async () => 'RESULTS: The primary outcome occurred in 6.5% vs 8.0% (HR 0.80; 95% CI 0.72-0.90). The trial was completed as planned.',
  } as unknown as PubMedClient
  const server = buildMcpServer({
    docs: env.docs, ops: env.ops, turns: registry, secret: SECRET, claims: new ClaimService(env.docs, pubmed), renderer: new SlideRenderer(workspace),
    pubmed, crossref,
    workspaceDir: () => workspace,
  }, claims)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> }
    const body = r.content[0]!.text
    let parsed: unknown = body
    try { parsed = JSON.parse(body) } catch { /* 纯文本视图 */ }
    return { isError: Boolean(r.isError), body: parsed as any, text: body }
  }
  return { ...env, client, call, registry, workspace }
}

describe('MCP 工具', () => {
  it('outline → read → edit → 引用的完整流程', async () => {
    const t = await connect('# 引言\n\n心衰常见。\n\n# 方法\n\n待补充。')
    const outline = await t.call('doc_outline', { doc_id: t.docId })
    expect(outline.text).toContain('rev=0')
    const methods = /# \{#([a-z0-9]+)\} 方法/.exec(outline.text)![1]!
    const read = await t.call('doc_read', { doc_id: t.docId, section_id: methods })
    const para = /\{#([a-z0-9]+)\} 待补充/.exec(read.text)![1]!

    const cite = await t.call('insert_citation', { doc_id: t.docId, doi: '10.1056/NEJMoa2020' })
    expect(cite.body.marker).toMatch(/^\[@c:c[a-z0-9]+\]$/)

    const edit = await t.call('doc_edit', {
      doc_id: t.docId, base_rev: 0,
      ops: [{ op: 'replace_block', id: para, markdown: `纳入 120 例患者${cite.body.marker}。` }],
    })
    expect(edit.isError).toBe(false)
    expect(edit.body.rev).toBe(1)
    const list = await t.call('list_citations', { doc_id: t.docId })
    expect(list.body[0].number).toBe(1)

    const bad = await t.call('doc_edit', { doc_id: t.docId, base_rev: 1, ops: [{ op: 'insert_after', anchor_id: para, markdown: '见 10.1056/NEJMoa2020' }] })
    expect(bad.isError).toBe(true)
    expect(bad.body.code).toBe('citation_not_registered')
    expect(bad.body.hint).toContain('insert_citation')

    const missing = await t.call('insert_citation', { doc_id: t.docId, doi: '10.9999/404' })
    expect(missing.body.code).toBe('doi_not_found')
  })

  it('回合内的写入带 turn_id，并通知回合', async () => {
    const t = await connect('段落。')
    const notices: unknown[] = []
    t.registry.begin('u1', { turnId: 'r1', touched: new Set(), notify: n => notices.push(n), mode: 'apply' })
    const read = await t.call('doc_read', { doc_id: t.docId })
    const id = /\{#([a-z0-9]+)\}/.exec(read.text)![1]!
    await t.call('doc_edit', { doc_id: t.docId, base_rev: 0, ops: [{ op: 'replace_text', id, find: '段落', replace: '新段落' }] })
    expect(t.store.opLog(t.docId)[0]!.turn_id).toBe('r1')
    expect(t.registry.active('u1')!.touched.has(t.docId)).toBe(true)
  })

  it('权限：别人的文档、只读令牌', async () => {
    const t = await connect('段落。', { p: ['read'] })
    const other = t.docs.create({ owner: 'someone-else', title: 'x' })
    expect((await t.call('doc_outline', { doc_id: other.id })).body.code).toBe('doc_not_found')
    const read = await t.call('doc_read', { doc_id: t.docId })
    const id = /\{#([a-z0-9]+)\}/.exec(read.text)![1]!
    const edit = await t.call('doc_edit', { doc_id: t.docId, base_rev: 0, ops: [{ op: 'delete', ids: [id] }] })
    expect(edit.body.code).toBe('forbidden')
  })

  it('asset_upload 只能读工作区内的图片，插入后渲染为图', async () => {
    const t = await connect('段落。')
    writeFileSync(join(t.workspace, 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const up = await t.call('asset_upload', { path: 'chart.png' })
    expect(up.body.asset_id).toMatch(/^a/)
    expect((await t.call('asset_upload', { path: '../../etc/passwd' })).isError).toBe(true)
    const read = await t.call('doc_read', { doc_id: t.docId })
    const id = /\{#([a-z0-9]+)\}/.exec(read.text)![1]!
    const edit = await t.call('doc_edit', { doc_id: t.docId, base_rev: 0, ops: [{ op: 'insert_after', anchor_id: id, markdown: `![心衰发病率](asset:${up.body.asset_id} "图 1")` }] })
    expect(edit.isError).toBe(false)
    expect(t.docs.get(t.docId).child(1).type.name).toBe('figure')
  })

  it('评论：读取锚点、回复、关闭', async () => {
    const t = await connect('心衰常见。')
    const node = t.docs.get(t.docId).child(0).attrs.id as string
    const c = t.store.addComment({ doc_id: t.docId, node_id: node, snippet: '' })
    t.store.addReply(c.id, 'user', '补充发病率数据')
    const list = await t.call('comments_list', { doc_id: t.docId })
    expect(list.body.comments[0].anchor.node_ids).toEqual([node])
    expect((await t.call('comment_resolve', { doc_id: t.docId, comment_id: c.id })).body.code).toBe('reply_required')
    await t.call('comment_reply', { doc_id: t.docId, comment_id: c.id, text: '已补充' })
    expect((await t.call('comment_resolve', { doc_id: t.docId, comment_id: c.id })).body.status).toBe('resolved')
  })

  it('doc_create 带初始内容；违反引用规范时不留下空文档', async () => {
    const t = await connect('x')
    const ok = await t.call('doc_create', { title: '新稿', markdown: '# 标题\n\n正文。' })
    expect(ok.body.rev).toBe(1)
    const bad = await t.call('doc_create', { title: '坏稿', markdown: 'doi:10.1056/abc' })
    expect(bad.body.code).toBe('citation_not_registered')
    const titles = (await t.call('doc_list', {})).body.map((d: { title: string }) => d.title)
    expect(titles).toContain('新稿')
    expect(titles).not.toContain('坏稿')
  })
})

describe('评论规则', () => {
  it('本回合改过文档后，AI 不能关闭线程', async () => {
    const t = await connect('心衰常见。')
    const node = t.docs.get(t.docId).child(0).attrs.id as string
    const c = t.store.addComment({ doc_id: t.docId, node_id: node, snippet: '' })
    t.registry.begin('u1', { turnId: 'r1', touched: new Set(), notify: () => {}, mode: 'apply' })
    await t.call('doc_edit', { doc_id: t.docId, base_rev: 0, ops: [{ op: 'replace_text', id: node, find: '常见', replace: '高发' }] })
    await t.call('comment_reply', { doc_id: t.docId, comment_id: c.id, text: '已改' })
    expect((await t.call('comment_resolve', { doc_id: t.docId, comment_id: c.id })).body.code).toBe('user_confirms_changes')
  })
})

describe('论断核对', () => {
  it('verify_claims 给出论断与摘要证据、缺出处的数值句；claim_report 挂评论且不重复', async () => {
    const t = await connect('占位。')
    const cite = t.store.upsertCitation({ doc_id: t.docId, doi: '10.1056/nejmoa2307563', pmid: null, formatted: 'Lincoff AM. SELECT. N Engl J Med. 2023.', url: null })
    const id = t.docs.get(t.docId).child(0).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id, markdown: `SELECT 试验因安全性问题提前终止[@c:${cite.id}]。另有研究纳入 120 例患者。` }] }, { actor: 'user', turnId: null })
    const ev = (await t.call('verify_claims', { doc_id: t.docId })).body
    expect(ev.claims).toHaveLength(1)
    expect(ev.claims[0].sentence).toBe('SELECT 试验因安全性问题提前终止[1]。')
    expect(ev.claims[0].citations[0].abstract).toContain('completed as planned')
    expect(ev.unsourced).toHaveLength(1)
    expect(ev.unsourced[0].sentence).toContain('120 例')
    const report = await t.call('claim_report', { doc_id: t.docId, results: [
      { claim_id: ev.claims[0].claim_id, verdict: 'unsupported', reason: '摘要显示试验按计划完成，并未提前终止。' },
      { claim_id: ev.unsourced[0].claim_id, verdict: 'missing_citation', reason: '样本量没有出处。' },
    ] })
    expect(report.body.results.map((r: { status: string }) => r.status)).toEqual(['commented', 'commented'])
    const comments = t.store.listComments(t.docId, 'open')
    expect(comments).toHaveLength(2)
    expect(comments[0]!.replies[0]!.text).toContain('不支持')
    // 同一结论再报一次不重复挂评论；句子改过后旧 claim_id 失效
    const again = await t.call('claim_report', { doc_id: t.docId, results: [{ claim_id: ev.claims[0].claim_id, verdict: 'unsupported', reason: '同上' }] })
    expect(again.body.results[0].status).toBe('unchanged')
    expect(t.store.listComments(t.docId, 'open')).toHaveLength(2)
    t.ops.edit({ doc_id: t.docId, base_rev: t.docs.rev(t.docId), mode: 'apply', ack_comments: comments.map(c => c.id), ops: [{ op: 'replace_text', id, find: '因安全性问题提前终止', replace: '按计划完成' }] }, { actor: 'user', turnId: null })
    const stale = await t.call('claim_report', { doc_id: t.docId, results: [{ claim_id: ev.claims[0].claim_id, verdict: 'supported', reason: 'x' }] })
    expect(stale.body.results[0].status).toBe('stale')
  })
})
