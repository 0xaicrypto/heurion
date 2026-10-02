import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { BotGuard, solveChallenge, type Challenge } from '../src/auth/bot-guard.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { SearchIndex } from '../src/model/search-index.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { TurnService } from '../src/turns/service.ts'

const SECRET = 'test-secret'

function env() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {} } as unknown as HarnessPool
  const accounts = new Accounts(store, { secret: SECRET, devMode: true, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: SECRET, baseMax: 300, minDelayMs: 0 }) })
  const search = new SearchIndex(docs, 0)
  const app = buildApi({
    docs, ops: new OpService(docs), turns: new TurnService(docs, pool, new TurnRegistry()), postcheck: new PostCheck(docs),
    crossref: {} as CrossrefClient, renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'hr-'))), accounts, devMode: true, devUser: 'dev', search,
  })
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined })
    const text = await res.text()
    let data: any = text
    try { data = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: res.status, data }
  }
  const register = async (username: string) => {
    const pow = solveChallenge((await (await app.request('/api/auth/challenge')).json()) as Challenge)
    const r = await app.request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'secret123', pow }) })
    return (await r.json()) as { token: string; user: { id: string } }
  }
  const settle = async () => { await new Promise(r => setTimeout(r, 5)); search.flush() }
  return { store, docs, call, register, settle, search }
}

describe('项目（文件夹）', () => {
  it('新建 / 改名 / 在项目里新建文档 / 移动 / 删除项目后文档回到未分组；别人的项目 id 不能用', async () => {
    const t = env()
    const a = await t.register('amy')
    const b = await t.register('ben')
    const p = (await t.call('POST', '/api/projects', a.token, { name: 'SELECT 汇报' })).data
    expect((await t.call('PATCH', `/api/projects/${p.id}`, a.token, { name: 'SELECT 试验汇报' })).data.name).toBe('SELECT 试验汇报')
    const d1 = (await t.call('POST', '/api/docs', a.token, { title: '综述', project_id: p.id })).data
    expect(d1.project_id).toBe(p.id)
    const d2 = (await t.call('POST', '/api/docs', a.token, { title: '笔记' })).data
    expect((await t.call('PATCH', `/api/docs/${d2.id}`, a.token, { project_id: p.id })).data.project_id).toBe(p.id)
    expect((await t.call('POST', '/api/docs', b.token, { title: 'x', project_id: p.id })).status).toBe(404)
    expect((await t.call('PATCH', `/api/projects/${p.id}`, b.token, { name: '偷改' })).status).toBe(404)
    expect((await t.call('GET', '/api/projects', b.token)).data).toEqual([])
    await t.call('DELETE', `/api/projects/${p.id}`, a.token)
    const list = (await t.call('GET', '/api/docs', a.token)).data
    expect(list.map((d: any) => [d.title, d.project_id]).sort()).toEqual([['笔记', null], ['综述', null]])
  })
})

describe('全文搜索', () => {
  it('3 个字以上走 trigram 索引，1–2 个字走 LIKE；命中片段带 [ ]；排除回收站与别人的文档；改字后索引更新', async () => {
    const t = env()
    const a = await t.register('amy')
    const b = await t.register('ben')
    const d1 = (await t.call('POST', '/api/docs', a.token, { title: '心衰综述', markdown: '# 引言\n\n心力衰竭是常见的临床综合征，SGLT2 抑制剂可降低住院风险。' })).data
    const d2 = (await t.call('POST', '/api/docs', a.token, { title: '糖尿病笔记', markdown: '二甲双胍是一线用药。' })).data
    await t.call('POST', '/api/docs', b.token, { title: '别人的心衰稿', markdown: '心力衰竭' })
    await t.settle()
    const long = (await t.call('GET', `/api/search?q=${encodeURIComponent('临床综合征')}`, a.token)).data
    expect(long.map((h: any) => h.doc_id)).toEqual([d1.id])
    expect(long[0].snippet).toContain('[临床综合征]')
    const short = (await t.call('GET', `/api/search?q=${encodeURIComponent('心衰')}`, a.token)).data
    expect(short.map((h: any) => h.title)).toEqual(['心衰综述']) // 只命中标题也算；不含别人的
    expect((await t.call('GET', `/api/search?q=${encodeURIComponent('SGLT2')}`, a.token)).data[0].snippet).toContain('[SGLT2]')
    await t.call('DELETE', `/api/docs/${d2.id}`, a.token)
    expect((await t.call('GET', `/api/search?q=${encodeURIComponent('二甲双胍')}`, a.token)).data).toEqual([])
    // 改字后索引更新
    const html = (await t.call('GET', `/api/docs/${d1.id}/html`, a.token)).data.html as string
    const para = [...html.matchAll(/data-id="([a-z0-9]+)"/g)][1]![1]
    await t.call('POST', `/api/docs/${d1.id}/edit`, a.token, { base_rev: 0, ops: [{ op: 'replace_text', id: para, find: 'SGLT2 抑制剂', replace: '沙库巴曲缬沙坦' }] })
    await t.settle()
    expect((await t.call('GET', `/api/search?q=${encodeURIComponent('沙库巴曲')}`, a.token)).data.map((h: any) => h.doc_id)).toEqual([d1.id])
  })
})

describe('回收站', () => {
  it('删除进回收站（不能打开、不能编辑）→ 恢复；彻底删除只对回收站里的文档；超过 30 天自动清理', async () => {
    const t = env()
    const a = await t.register('amy')
    const d = (await t.call('POST', '/api/docs', a.token, { title: '草稿', markdown: '内容。' })).data
    expect((await t.call('DELETE', `/api/docs/${d.id}/purge`, a.token)).status).toBe(404) // 不在回收站
    expect((await t.call('DELETE', `/api/docs/${d.id}`, a.token)).data.trashed).toBe(true)
    expect((await t.call('GET', '/api/docs', a.token)).data).toEqual([])
    expect((await t.call('GET', `/api/docs/${d.id}`, a.token)).status).toBe(404)
    expect((await t.call('POST', `/api/docs/${d.id}/edit`, a.token, { base_rev: 0, ops: [] })).status).toBe(404)
    expect((await t.call('GET', '/api/trash', a.token)).data.map((x: any) => x.id)).toEqual([d.id])
    await t.call('POST', `/api/docs/${d.id}/restore`, a.token)
    expect((await t.call('GET', `/api/docs/${d.id}`, a.token)).data.title).toBe('草稿')
    await t.call('DELETE', `/api/docs/${d.id}`, a.token)
    await t.call('DELETE', `/api/docs/${d.id}/purge`, a.token)
    expect(t.store.getDoc(d.id)).toBeUndefined()
    // 自动清理：回收站里超过 30 天的
    const old = (await t.call('POST', '/api/docs', a.token, { title: '旧' })).data
    await t.call('DELETE', `/api/docs/${old.id}`, a.token)
    t.store.db.prepare('UPDATE docs SET deleted_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * 86400_000).toISOString(), old.id)
    expect(t.store.purgeTrash(30)).toEqual([old.id])
  })
})

describe('复制文档', () => {
  it('内容、项目一起复制；引用换新 id 且正文标记跟着改；幻灯片连同原始 pptx 包', async () => {
    const t = env()
    const a = await t.register('amy')
    const p = (await t.call('POST', '/api/projects', a.token, { name: '项目' })).data
    const d = (await t.call('POST', '/api/docs', a.token, { title: '证据', project_id: p.id, markdown: '占位。' })).data
    const c = t.store.upsertCitation({ doc_id: d.id, doi: '10.1056/x', pmid: '1', formatted: 'X et al.', url: null })
    const html = (await t.call('GET', `/api/docs/${d.id}/html`, a.token)).data.html as string
    const para = /data-id="([a-z0-9]+)"/.exec(html)![1]
    await t.call('POST', `/api/docs/${d.id}/edit`, a.token, { base_rev: 0, ops: [{ op: 'replace_block', id: para, markdown: `HR 0.80[@c:${c.id}]。` }] })
    const copy = (await t.call('POST', `/api/docs/${d.id}/duplicate`, a.token)).data
    expect([copy.title, copy.project_id]).toEqual(['证据（副本）', p.id])
    const cites = t.store.listCitations(copy.id)
    expect(cites.length).toBe(1)
    expect(cites[0]!.id).not.toBe(c.id)
    const md = (await t.call('GET', `/api/docs/${copy.id}/read`, a.token)).data as string
    expect(md).toContain(`[@c:${cites[0]!.id}]`)
    const deck = (await t.call('POST', '/api/docs', a.token, { title: '汇报', kind: 'deck' })).data
    const dcopy = (await t.call('POST', `/api/docs/${deck.id}/duplicate`, a.token)).data
    expect(t.store.getPackage(dcopy.id)).toBeTruthy()
    expect((await t.call('GET', `/api/docs/${dcopy.id}/export.pptx`, a.token)).status).toBe(200)
  })
})
