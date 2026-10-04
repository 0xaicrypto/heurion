import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { BotGuard, solveChallenge, type Challenge } from '../src/auth/bot-guard.ts'
import { issueToken, verifyToken } from '../src/auth/token.ts'
import { ClaimService } from '../src/claims/service.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { DatasetService } from '../src/datasets/service.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { buildMcpServer } from '../src/mcp/server.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { MemoryService } from '../src/memory/service.ts'
import { MemorySignals } from '../src/memory/signals.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Access } from '../src/research/access.ts'
import { StudyService } from '../src/research/service.ts'
import { Store } from '../src/store/db.ts'
import { TurnService } from '../src/turns/service.ts'

/**
 * 研究团队协作（docs/design/TEAM.md）：同机构成员共享研究里的文档、数据集、分析；角色 owner / editor / viewer。
 * 机构 A：alice（机构管理员）、carol、dave；机构 B：bob。
 */

const SECRET = 'team-secret'
const MARK = '团队暗号-31c9'

async function setup() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {}, workspaceDir: () => mkdtempSync(join(tmpdir(), 'team-ws-')) } as unknown as HarnessPool
  const accounts = new Accounts(store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: SECRET, baseMax: 300, minDelayMs: 0 }) })
  const memory = new MemoryService(store, null)
  const datasets = new DatasetService(store, mkdtempSync(join(tmpdir(), 'team-ds-')), async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-dso-'))
    writeFileSync(join(dir, 'data.csv'), `note\n${MARK}\n`)
    return { csv: join(dir, 'data.csv'), cleanup: () => {}, profile: { ok: true, rows: 1, truncated: false, columns: [{ name: 'note', type: 'text', missing: 0, unique: 1, top: [{ value: MARK, count: 1 }] }] } }
  })
  const access = new Access(store)
  access.docText = id => JSON.stringify(docs.get(id).toJSON())
  datasets.access = access
  const studies = new StudyService(store, datasets, access)
  const ops = new OpService(docs)
  new MemorySignals(store, memory, docs)
  const app = buildApi({
    docs, ops, turns: new TurnService(docs, pool, new TurnRegistry(), { memory }), postcheck: new PostCheck(docs), crossref: {} as CrossrefClient,
    renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'team-r-'))), accounts, devMode: false, devUser: 'dev', memory, datasets, studies, access,
  })
  const call = async (method: string, path: string, token?: string, body?: unknown, form?: FormData) => {
    if (/^\/api\/auth\/(register|login)$/.test(path)) body = { ...(body as object), pow: solveChallenge((await (await app.request('/api/auth/challenge')).json()) as Challenge) }
    const res = await app.request(path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    })
    const text = await res.text()
    return { status: res.status, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
  }
  const register = async (username: string, invite?: string) => (await call('POST', '/api/auth/register', undefined, { username, password: 'passw0rd123', ...(invite ? { invite } : {}) })).json
  const op = await register('operator')
  const orgA = (await call('POST', '/api/platform/tenants', op.token, { name: '医院 A' })).json
  const alice = await register('alice', orgA.invite.code)
  const inviteMember = async () => (await call('POST', '/api/tenant/invites', alice.token, {})).json.code
  const carol = await register('carol', await inviteMember())
  const dave = await register('dave', await inviteMember())
  const orgB = (await call('POST', '/api/platform/tenants', op.token, { name: '医院 B' })).json
  const bob = await register('bob', orgB.invite.code)

  // alice 的研究：方案文档（带一张图）、数据集、一张用数据集画的分析图
  const study = (await call('POST', '/api/studies', alice.token, { title: `研究 ${MARK}` })).json
  const doc = (await call('POST', '/api/docs', alice.token, { title: `方案 ${MARK}`, markdown: `# 方案\n\n正文 ${MARK}。` })).json
  await call('POST', `/api/studies/${study.id}/items`, alice.token, { kind: 'doc', ref_id: doc.id, role: 'protocol' })
  const imgForm = new FormData(); imgForm.append('file', new File([Buffer.from('89504e470d0a1a0a', 'hex')], 'fig.png', { type: 'image/png' }))
  const figure = (await call('POST', `/api/docs/${doc.id}/assets`, alice.token, undefined, imgForm)).json
  const first = docs.get(doc.id).firstChild!.attrs.id as string
  const ins = await call('POST', `/api/docs/${doc.id}/edit`, alice.token, { base_rev: docs.rev(doc.id), ops: [{ op: 'insert_after', anchor_id: first, markdown: `![图](asset:${figure.asset_id} "图 1")` }] })
  expect(ins.status).toBe(200)
  const dsForm = new FormData(); dsForm.append('file', new File(['x'], 'trial.csv'))
  const dataset = (await call('POST', '/api/datasets', alice.token, undefined, dsForm)).json[0]
  await datasets.idle()
  await call('POST', `/api/studies/${study.id}/items`, alice.token, { kind: 'dataset', ref_id: dataset.id })
  const analysis = store.putAsset({ owner: alice.user.id, mime: 'image/png', name: 'km.png', bytes: new Uint8Array([1, 2, 3]), provenance: { code: 'print(1)', code_path: 'km.py', datasets: [{ id: dataset.id, name: 'trial', version: 1, rows: 1 }], turn_id: null, at: new Date().toISOString() } })
  return { store, docs, ops, memory, datasets, studies, access, app, call, alice, carol, dave, bob, op, study, doc, dataset, figure, analysis }
}

type T = Awaited<ReturnType<typeof setup>>
/** 正文段落（不是标题、不是图） */
const textBlock = (t: T) => { let p = t.docs.get(t.doc.id).firstChild!; t.docs.get(t.doc.id).forEach(n => { if (n.type.name === 'paragraph' && n.textContent.includes('正文')) p = n }); return p }
/** 一个成员能做什么：读文档 / 改文档 / 看数据 / 改数据 / 看图 / 看研究 */
async function can(t: T, token: string) {
  const s = (r: { status: number }) => r.status < 400
  return {
    readDoc: s(await t.call('GET', `/api/docs/${t.doc.id}/read`, token)),
    editDoc: s(await t.call('PATCH', `/api/docs/${t.doc.id}`, token, { title: `方案 ${MARK} v2` })),
    readData: s(await t.call('GET', `/api/datasets/${t.dataset.id}/preview`, token)),
    editData: s(await t.call('PATCH', `/api/datasets/${t.dataset.id}`, token, { name: 'trial-2' })),
    figure: s(await t.call('GET', `/api/assets/${t.figure.asset_id}`, token)),
    analysis: s(await t.call('GET', `/api/assets/${t.analysis.id}`, token)),
    study: s(await t.call('GET', `/api/studies/${t.study.id}`, token)),
    comment: s(await t.call('POST', `/api/docs/${t.doc.id}/comments`, token, { node_id: t.docs.get(t.doc.id).firstChild!.attrs.id, snippet: '方案', text: '看过了' })),
  }
}
const NONE = { readDoc: false, editDoc: false, readData: false, editData: false, figure: false, analysis: false, study: false, comment: false }

describe('研究团队：权限矩阵', () => {
  it('非成员 / 跨机构看不到；editor 能读能改；viewer 只读能评论；移出后看不到', async () => {
    const t = await setup()
    expect(await can(t, t.carol.token)).toEqual(NONE)
    expect(await can(t, t.bob.token)).toEqual(NONE)

    // 跨机构的人加不进来
    expect((await t.call('POST', `/api/studies/${t.study.id}/members`, t.alice.token, { user_id: t.bob.user.id, role: 'editor' })).status).toBe(400)
    // 可加的人：只有本机构的
    const cands = (await t.call('GET', `/api/studies/${t.study.id}/candidates`, t.alice.token)).json.map((u: { user_id: string }) => u.user_id)
    expect(cands.sort()).toEqual([t.carol.user.id, t.dave.user.id].sort())

    expect((await t.call('POST', `/api/studies/${t.study.id}/members`, t.alice.token, { user_id: t.carol.user.id, role: 'editor' })).status).toBe(201)
    expect(await can(t, t.carol.token)).toEqual({ readDoc: true, editDoc: true, readData: true, editData: true, figure: true, analysis: true, study: true, comment: true })
    // 研究列表、数据集列表里标出共享
    const mine = (await t.call('GET', '/api/studies', t.carol.token)).json
    expect(mine).toEqual([expect.objectContaining({ id: t.study.id, my_role: 'editor', shared: true, shared_by: 'alice' })])
    expect((await t.call('GET', '/api/datasets', t.carol.token)).json).toEqual([expect.objectContaining({ id: t.dataset.id, shared: true })])
    // 文档详情带协作者与我的角色
    const d = (await t.call('GET', `/api/docs/${t.doc.id}`, t.carol.token)).json
    expect(d.my_role).toBe('editor')
    expect(d.collaborators.map((m: { name: string }) => m.name).sort()).toEqual(['alice', 'carol'])
    // editor 不能删别人建的文档，不能管成员
    expect((await t.call('DELETE', `/api/docs/${t.doc.id}`, t.carol.token)).status).toBe(403)
    expect((await t.call('POST', `/api/studies/${t.study.id}/members`, t.carol.token, { user_id: t.dave.user.id })).status).toBe(403)
    expect((await t.call('DELETE', `/api/studies/${t.study.id}`, t.carol.token)).status).toBe(403)

    // 改成只读
    expect((await t.call('PATCH', `/api/studies/${t.study.id}/members/${t.carol.user.id}`, t.alice.token, { role: 'viewer' })).status).toBe(200)
    expect(await can(t, t.carol.token)).toEqual({ readDoc: true, editDoc: false, readData: true, editData: false, figure: true, analysis: true, study: true, comment: true })
    const block = t.docs.get(t.doc.id).firstChild!.attrs.id as string
    const denied = await t.call('POST', `/api/docs/${t.doc.id}/edit`, t.carol.token, { base_rev: t.docs.rev(t.doc.id), ops: [{ op: 'replace_text', id: block, find: '方案', replace: '改了' }] })
    expect(denied.status).toBe(403)
    expect((await t.call('POST', `/api/studies/${t.study.id}/items`, t.carol.token, { kind: 'doc', ref_id: t.doc.id })).status).toBe(403)
    expect((await t.call('POST', `/api/studies/${t.study.id}/cohort/dataset`, t.carol.token, {})).status).toBeGreaterThanOrEqual(400)

    // 移出：全部看不到
    expect((await t.call('DELETE', `/api/studies/${t.study.id}/members/${t.carol.user.id}`, t.alice.token)).status).toBe(200)
    expect(await can(t, t.carol.token)).toEqual(NONE)
    expect((await t.call('GET', '/api/studies', t.carol.token)).json).toEqual([])
    // 负责人不受影响
    expect((await t.call('GET', `/api/docs/${t.doc.id}/read`, t.alice.token)).text).toContain(MARK)
  })

  it('转交、退出、离职交接', async () => {
    const t = await setup()
    await t.call('POST', `/api/studies/${t.study.id}/members`, t.alice.token, { user_id: t.carol.user.id, role: 'editor' })
    // 负责人不能直接退出
    expect((await t.call('DELETE', `/api/studies/${t.study.id}/members/${t.alice.user.id}`, t.alice.token)).status).toBe(409)
    // 转交给 carol：alice 变成 editor，不能再管成员
    expect((await t.call('POST', `/api/studies/${t.study.id}/transfer`, t.alice.token, { user_id: t.carol.user.id })).status).toBe(200)
    expect(t.store.getStudy(t.study.id)!.owner).toBe(t.carol.user.id)
    expect(t.store.studyRole(t.study.id, t.alice.user.id)).toBe('editor')
    expect((await t.call('POST', `/api/studies/${t.study.id}/members`, t.alice.token, { user_id: t.dave.user.id })).status).toBe(403)
    // 新负责人移出原负责人：原负责人连自己当初建的文档都看不到了（研究里的内容属于研究）
    expect((await t.call('DELETE', `/api/studies/${t.study.id}/members/${t.alice.user.id}`, t.carol.token)).status).toBe(200)
    expect((await t.call('GET', `/api/docs/${t.doc.id}/read`, t.alice.token)).status).toBe(404)
    expect((await t.call('GET', `/api/datasets/${t.dataset.id}`, t.alice.token)).status).toBe(404)

    // 成员自己退出
    await t.call('POST', `/api/studies/${t.study.id}/members`, t.carol.token, { user_id: t.dave.user.id, role: 'viewer' })
    expect((await t.call('DELETE', `/api/studies/${t.study.id}/members/${t.dave.user.id}`, t.dave.token)).status).toBe(200)
    expect((await t.call('GET', `/api/studies/${t.study.id}`, t.dave.token)).status).toBe(404)

    // 离职交接：机构管理员 alice（已不是成员）把 carol 的研究交给 dave；alice 看到的只有元数据，交接后也读不到内容
    const listed = (await t.call('GET', '/api/tenant/studies', t.alice.token)).json
    expect(listed).toEqual([expect.objectContaining({ study_id: t.study.id, owner: t.carol.user.id })])
    expect(JSON.stringify(listed)).not.toContain(t.doc.id)
    expect((await t.call('GET', '/api/tenant/studies', t.carol.token)).status).toBe(403) // 不是管理员
    expect((await t.call('POST', `/api/studies/${t.study.id}/handover`, t.carol.token, { user_id: t.dave.user.id })).status).toBe(404)
    expect((await t.call('POST', `/api/studies/${t.study.id}/handover`, t.bob.token, { user_id: t.bob.user.id })).status).toBe(404) // 别的机构
    expect((await t.call('POST', `/api/studies/${t.study.id}/handover`, t.alice.token, { user_id: t.dave.user.id })).status).toBe(200)
    expect(t.store.getStudy(t.study.id)!.owner).toBe(t.dave.user.id)
    expect(t.store.studyRole(t.study.id, t.carol.user.id)).toBeNull()
    expect((await t.call('GET', `/api/studies/${t.study.id}`, t.alice.token)).status).toBe(404)
    expect((await t.call('GET', `/api/docs/${t.doc.id}/read`, t.dave.token)).text).toContain(MARK)
    // 交接写进审计
    expect(t.store.listAudit({ tenant: t.store.getUser(t.alice.user.id)!.tenant_id! }).some(e => e.action === 'study.handover')).toBe(true)
  })

  it('研究外的个人文档仍只属于本人；分析汇总包含所有成员画的图', async () => {
    const t = await setup()
    await t.call('POST', `/api/studies/${t.study.id}/members`, t.alice.token, { user_id: t.carol.user.id, role: 'editor' })
    const personal = (await t.call('POST', '/api/docs', t.alice.token, { title: `个人 ${MARK}` })).json
    expect((await t.call('GET', `/api/docs/${personal.id}/read`, t.carol.token)).status).toBe(404)
    // carol 用研究数据集画了一张图：出现在研究的「分析」里，alice 也能看
    const mine = t.store.putAsset({ owner: t.carol.user.id, mime: 'image/png', name: 'carol.png', bytes: new Uint8Array([9]), provenance: { code: null, code_path: null, datasets: [{ id: t.dataset.id, name: 'trial', version: 1, rows: 1 }], turn_id: null, at: new Date().toISOString() } })
    const st = (await t.call('GET', `/api/studies/${t.study.id}`, t.alice.token)).json
    expect(st.analyses.map((a: { asset_id: string }) => a.asset_id).sort()).toEqual([t.analysis.id, mine.id].sort())
    expect(st.analyses.find((a: { asset_id: string }) => a.asset_id === mine.id).by).toBe('carol')
    expect((await t.call('GET', `/api/assets/${mine.id}`, t.alice.token)).status).toBe(200)
    // carol 自己的、与研究无关的图别人看不到
    const priv = t.store.putAsset({ owner: t.carol.user.id, mime: 'image/png', name: 'p.png', bytes: new Uint8Array([7]) })
    expect((await t.call('GET', `/api/assets/${priv.id}`, t.alice.token)).status).toBe(404)
  })
})

describe('研究团队：记忆信号只记在实际改动的人名下', () => {
  it('共享文档里 carol 改了 AI 写的段落 → 记在 carol 名下，不进 alice 的记忆', async () => {
    const t = await setup()
    await t.call('POST', `/api/studies/${t.study.id}/members`, t.alice.token, { user_id: t.carol.user.id, role: 'editor' })
    const para = textBlock(t)
    // AI 写一段（alice 的回合）
    t.ops.edit({ doc_id: t.doc.id, base_rev: t.docs.rev(t.doc.id), mode: 'apply', ops: [{ op: 'replace_block', id: para.attrs.id as string, markdown: 'AI 写的一段较长的文字内容。' }] } as never, { actor: 'ai', turnId: 't1' })
    // carol 改这一段（接口调用，带 user）
    const r = await t.call('POST', `/api/docs/${t.doc.id}/edit`, t.carol.token, { base_rev: t.docs.rev(t.doc.id), ops: [{ op: 'replace_text', id: para.attrs.id, find: 'AI 写的', replace: '我改过的' }] })
    expect(r.status).toBe(200)
    expect(t.store.openMemorySignals(t.carol.user.id).length).toBe(1)
    expect(t.store.openMemorySignals(t.alice.user.id).length).toBe(0)
  })

  it('分不清是谁改的（多人合批、没有用户）不记', async () => {
    const t = await setup()
    const para = textBlock(t)
    t.ops.edit({ doc_id: t.doc.id, base_rev: t.docs.rev(t.doc.id), mode: 'apply', ops: [{ op: 'replace_block', id: para.attrs.id as string, markdown: 'AI 写的另一段较长文字。' }] } as never, { actor: 'ai', turnId: 't2' })
    t.ops.edit({ doc_id: t.doc.id, base_rev: t.docs.rev(t.doc.id), mode: 'apply', ops: [{ op: 'replace_text', id: para.attrs.id as string, find: 'AI 写的', replace: '有人改的' }] } as never, { actor: 'user', turnId: null })
    expect(t.store.openMemorySignals(t.alice.user.id).length).toBe(0)
  })
})

describe('研究团队：AI 与人同等（MCP）', () => {
  it('AI 的能力随用户在研究里的角色；doc_list / study_list 带共享项；study_members 管成员', async () => {
    const t = await setup()
    const connect = async (userId: string) => {
      const claims = verifyToken(SECRET, issueToken(SECRET, { u: userId, d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 60 }), 'mcp')!
      const server = buildMcpServer({
        docs: t.docs, ops: t.ops, turns: new TurnRegistry(), secret: SECRET, claims: new ClaimService(t.docs, {} as PubMedClient), renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'team-m-'))),
        pubmed: {} as PubMedClient, crossref: {} as CrossrefClient, workspaceDir: () => tmpdir(), isLiveSession: () => true, datasets: t.datasets, studies: t.studies, access: t.access,
      }, claims)
      const [a, b] = InMemoryTransport.createLinkedPair()
      await server.connect(a)
      const client = new Client({ name: 'team', version: '0' })
      await client.connect(b)
      return async (name: string, args: Record<string, unknown>) => {
        const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text?: string }> }
        return { error: !!r.isError, text: r.content.map(c => c.text ?? '').join('') }
      }
    }
    const alice = await connect(t.alice.user.id)
    const carol = await connect(t.carol.user.id)
    expect((await carol('doc_read', { doc_id: t.doc.id })).text).not.toContain(MARK)
    // AI 替负责人加成员（与界面同一个方法）
    const added = await alice('study_members', { study_id: t.study.id, action: 'add', user_id: t.carol.user.id, role: 'viewer' })
    expect(added.error).toBe(false)
    expect((await carol('doc_read', { doc_id: t.doc.id })).text).toContain(MARK)
    const list = JSON.parse((await carol('doc_list', {})).text)
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ doc_id: t.doc.id, role: 'viewer', shared_by: 'alice', study_id: t.study.id })]))
    expect(JSON.parse((await carol('study_list', {})).text)).toEqual([expect.objectContaining({ study_id: t.study.id, role: 'viewer', shared_by: 'alice' })])
    // viewer 的 AI 不能改
    const para = t.docs.get(t.doc.id).firstChild!.attrs.id as string
    const edit = await carol('doc_edit', { doc_id: t.doc.id, base_rev: t.docs.rev(t.doc.id), ops: [{ op: 'replace_text', id: para, find: '方案', replace: 'X' }] })
    expect(edit.error).toBe(true)
    expect(edit.text).toContain('只读')
    expect((await carol('study_members', { study_id: t.study.id, action: 'add', user_id: t.dave.user.id })).error).toBe(true)
    // 改成 editor 后 AI 能改
    await alice('study_members', { study_id: t.study.id, action: 'set_role', user_id: t.carol.user.id, role: 'editor' })
    const ok = await carol('doc_edit', { doc_id: t.doc.id, base_rev: t.docs.rev(t.doc.id), ops: [{ op: 'replace_text', id: para, find: '方案', replace: '研究方案' }] })
    expect(ok.error).toBe(false)
    expect(JSON.parse((await carol('study_members', { study_id: t.study.id, action: 'list' })).text).map((m: { name: string; role: string }) => `${m.name}:${m.role}`).sort()).toEqual(['alice:owner', 'carol:editor'])
    // AI 替成员退出
    expect((await carol('study_members', { study_id: t.study.id, action: 'leave' })).error).toBe(false)
    expect((await carol('doc_read', { doc_id: t.doc.id })).text).not.toContain(MARK)
  })
})
