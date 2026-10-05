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
import { MemoryService } from '../src/memory/service.ts'
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
    crossref: {} as CrossrefClient, renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'hr-'))), accounts, devMode: true, devUser: 'dev', search, memory: new MemoryService(store, null),
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
  const pow = async () => solveChallenge((await (await app.request('/api/auth/challenge')).json()) as Challenge)
  return { store, docs, call, register, settle, search, pow }
}

describe('健康检查', () => {
  it('/healthz 不需要登录', async () => {
    const t = env()
    const r = await t.call('GET', '/healthz', '')
    expect([r.status, r.data.ok]).toEqual([200, true])
  })
})

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

describe('记忆 API', () => {
  it('手动添加 → 改种类与范围 → 历史；别人的记忆与项目不能动；暂停与清空；导入进待确认', async () => {
    const t = env()
    const a = await t.register('amy')
    const b = await t.register('ben')
    const p = (await t.call('POST', '/api/projects', a.token, { name: 'SELECT' })).data
    const pb = (await t.call('POST', '/api/projects', b.token, { name: '别人的' })).data
    const m = (await t.call('POST', '/api/memory', a.token, { content: '数值保留两位小数', kind: 'preference' })).data.memory
    expect(m.status).toBe('active')
    const edited = (await t.call('PATCH', `/api/memory/${m.id}`, a.token, { kind: 'style', scope: 'project', project_id: p.id })).data
    expect([edited.kind, edited.scope, edited.project_id]).toEqual(['style', 'project', p.id])
    expect((await t.call('PATCH', `/api/memory/${m.id}`, a.token, { scope: 'project', project_id: pb.id })).status).toBe(404)
    expect((await t.call('GET', `/api/memory/${m.id}/events`, a.token)).data.map((e: any) => e.action)).toEqual(['create', 'edit'])
    expect((await t.call('PATCH', `/api/memory/${m.id}`, b.token, { content: '偷改' })).status).toBe(404)
    expect((await t.call('DELETE', `/api/memory/${m.id}`, b.token)).status).toBe(404)
    expect((await t.call('GET', '/api/memory', b.token)).data.items).toEqual([])
    expect((await t.call('POST', '/api/memory', a.token, { content: '住院号：12345', kind: 'fact' })).data.code).toBe('sensitive_content')

    await t.call('PUT', '/api/memory/settings', a.token, { paused: true })
    expect((await t.call('GET', '/api/memory', a.token)).data).toMatchObject({ paused: true, enabled: false })
    await t.call('PUT', '/api/memory/settings', a.token, { paused: false })
    const imp = (await t.call('POST', '/api/memory-import', a.token, { items: [{ content: '术语统一用「心衰」', kind: 'term' }] })).data
    expect(imp.added).toBe(1)
    expect((await t.call('GET', '/api/memory', a.token)).data.items.map((x: any) => x.status).sort()).toEqual(['active', 'proposed'])
    expect((await t.call('DELETE', '/api/memory', a.token)).data.deleted).toBe(2)
  })
})

describe('审计日志', () => {
  it('记录登录（含失败）、导出、彻底删除（删除前的标题）；只有管理员能看', async () => {
    const t = env()
    const admin = await t.register('auditadmin') // 第一个注册的是管理员
    const user = await t.register('auditor')
    const login = async (password: string) => t.call('POST', '/api/auth/login', '', { username: 'auditor', password, pow: await t.pow() })
    expect((await login('wrong-password')).status).toBe(401)
    expect((await login('secret123')).status).toBe(200)
    const doc = (await t.call('POST', '/api/docs', user.token, { title: '病例讨论', markdown: '# x' })).data
    expect((await t.call('GET', `/api/docs/${doc.id}/export.md`, user.token)).status).toBe(200)
    await t.call('DELETE', `/api/docs/${doc.id}`, user.token)
    await t.call('DELETE', `/api/docs/${doc.id}/purge`, user.token)
    expect((await t.call('GET', '/api/admin/audit', user.token)).status).toBe(403)
    const rows = (await t.call('GET', '/api/admin/audit', admin.token)).data as any[]
    const actions = rows.map(r => r.action)
    expect(actions).toEqual(expect.arrayContaining(['auth.register', 'auth.login_failed', 'auth.login', 'doc.export', 'doc.trash', 'doc.purge']))
    expect(rows.find(r => r.action === 'auth.login_failed').detail).toContain('auditor')
    expect(rows.find(r => r.action === 'doc.purge')).toMatchObject({ actor_name: 'auditor', target: expect.stringContaining('《病例讨论》') })
    expect(rows.find(r => r.action === 'doc.export').target).toContain('《病例讨论》')
    const onlyDocs = (await t.call('GET', '/api/admin/audit?action=doc.&actor=auditor', admin.token)).data as any[]
    expect(onlyDocs.every((r: any) => r.action.startsWith('doc.') && r.actor_name === 'auditor')).toBe(true)
  })
})

describe('事务与文档运行时内存管理', () => {
  it('Store.transaction：异常时自动回滚，外层捕获后数据完整无残留', () => {
    const store = new Store(':memory:')
    expect(() => {
      store.transaction(() => {
        store.createProject('u1', 'p1')
        throw new Error('boom')
      })
    }).toThrow('boom')
    expect(store.listProjects('u1')).toEqual([])
  })

  it('Store.transaction：支持嵌套保存点，内层成功时生效', () => {
    const store = new Store(':memory:')
    store.transaction(() => {
      store.createProject('u1', 'p1')
      store.transaction(() => {
        store.createProject('u1', 'p2')
      })
    })
    expect(store.listProjects('u1').map(p => p.name).sort()).toEqual(['p1', 'p2'])
  })

  it('Documents：pin/unpin 保护活跃文档，evictIdle 仅驱逐空闲已落库文档', () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const doc1 = docs.create({ owner: 'u1', title: 'd1' })
    const doc2 = docs.create({ owner: 'u1', title: 'd2' })

    // 读入内存
    docs.get(doc1.id)
    docs.get(doc2.id)

    // pin 住 doc1
    docs.pin(doc1.id)

    // evictIdle 0ms（立即满足空闲超时）：doc1 由于被 pin 不会被驱逐，doc2 会被驱逐
    const evicted = docs.evictIdle(0)
    expect(evicted).toBe(1)

    // doc1 仍在内存中；unpin 后可被驱逐
    docs.unpin(doc1.id)
    expect(docs.evictIdle(0)).toBe(1)
  })
})

