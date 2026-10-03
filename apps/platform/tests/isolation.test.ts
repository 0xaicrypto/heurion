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
import { KbService } from '../src/kb/service.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { buildMcpServer } from '../src/mcp/server.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { MemoryEvolution } from '../src/memory/evolve.ts'
import { MemoryService } from '../src/memory/service.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { TurnService } from '../src/turns/service.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService } from '../src/tenancy/patients.ts'

/**
 * 跨租户 / 跨用户越权（docs/design/TENANCY.md §9，上线门槛）：
 * 机构 A 的用户建好每一种资源（内容里埋暗号），机构 B 的用户和平台运营带着 A 的 id 调用**每一个**带参数的接口与 MCP 工具，
 * 必须全部被拒绝，且响应里不能出现暗号。新加的接口 / 工具参数没登记在 PARAMS / TOOL_PARAMS 里时测试失败——逼着新代码补上越权测试。
 */

const SECRET = 'test-secret'
const MARK = '机密暗号-7f3a91'

/** 机构 A 的资源 → 接口参数（新接口的参数必须在这里登记）。 */
type Seed = Record<'doc' | 'dataset' | 'kb' | 'memory' | 'comment' | 'project' | 'userA' | 'invite' | 'tenantA' | 'job' | 'turn' | 'asset' | 'change' | 'patient' | 'lab' | 'pfile' | 'proposal' | 'record', string>
const PARAMS: Record<string, (s: Seed) => string> = {
  id: s => s.doc, did: s => s.dataset, fid: s => s.kb, mid: s => s.memory, cid: s => s.comment, pid: s => s.project,
  uid: s => s.userA, code: s => s.invite, tid: s => s.tenantA, jid: s => s.job, turnId: s => s.turn, seq: () => '1', index: () => '0', group: () => 'g1',
  action: () => 'x', ptid: s => s.patient, lid: s => s.lab, pfid: s => s.pfile, prid: s => s.proposal, rcid: s => s.record,
}
/** 按设计公开的接口（不需要登录或本身就是给持有链接的人用的）。 */
const PUBLIC: Record<string, string> = {
  'GET /api/invites/:code': '邀请链接本身就是凭证：持有者能看到机构名称以便注册（不含任何业务数据）',
}
/** 平台运营按设计可以做的（管账号与机构，不碰业务内容）。 */
const OPERATOR_ALLOWED = new Set([
  'PATCH /api/admin/users/:uid', 'POST /api/admin/users/:uid/reset-password', 'POST /api/admin/users/:uid/logout', 'PATCH /api/platform/tenants/:tid',
])

async function setup() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {}, workspaceDir: () => mkdtempSync(join(tmpdir(), 'iso-ws-')) } as unknown as HarnessPool
  const accounts = new Accounts(store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: SECRET, baseMax: 300, minDelayMs: 0 }) })
  const memory = new MemoryService(store, null)
  const evolution = new MemoryEvolution(store, memory, docs, async () => '{"changes":[]}')
  const datasets = new DatasetService(store, mkdtempSync(join(tmpdir(), 'iso-ds-')), async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iso-dso-'))
    writeFileSync(join(dir, 'data.csv'), `note\n${MARK}\n`)
    return { csv: join(dir, 'data.csv'), cleanup: () => {}, profile: { ok: true, rows: 1, truncated: false, columns: [{ name: 'note', type: 'text', missing: 0, unique: 1, top: [{ value: MARK, count: 1 }] }] } }
  })
  const kb = new KbService(store, null)
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'iso-pt-')), new TenantService(store, { devMode: false }), new TenantKeys(store, kekFrom({ secret: SECRET })), store)
  const turns = new TurnService(docs, pool, new TurnRegistry(), { memory })
  const ops = new OpService(docs)
  const app = buildApi({
    docs, ops, turns, postcheck: new PostCheck(docs), crossref: {} as CrossrefClient,
    renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'iso-r-'))), accounts, devMode: false, devUser: 'dev', kb, memory, evolution, datasets, patients,
  })
  const call = async (method: string, path: string, token?: string, body?: unknown, form?: FormData) => {
    if (/^\/api\/auth\/(register|login)$/.test(path)) body = { ...(body as object), pow: solveChallenge((await (await app.request('/api/auth/challenge')).json()) as Challenge) }
    const res = await app.request(path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    })
    return { status: res.status, text: await res.text() }
  }
  const json = async (...args: Parameters<typeof call>) => JSON.parse((await call(...args)).text)
  const register = async (username: string, invite?: string) => json('POST', '/api/auth/register', undefined, { username, password: 'passw0rd123', ...(invite ? { invite } : {}) })

  const op = await register('operator') // 第一个注册的是平台运营
  const created = await json('POST', '/api/platform/tenants', op.token, { name: '医院 A' })
  const A = await register('alice', created.invite.code)
  const created2 = await json('POST', '/api/platform/tenants', op.token, { name: '医院 B' })
  const B = await register('bob', created2.invite.code)

  // —— 机构 A 的每一种资源（都带暗号）——
  const doc = await json('POST', '/api/docs', A.token, { title: `A 的文稿 ${MARK}`, markdown: `# ${MARK}\n\n正文 ${MARK}。` })
  const block = docs.get(doc.id).firstChild!.attrs.id as string
  const comment = await json('POST', `/api/docs/${doc.id}/comments`, A.token, { node_id: block, snippet: MARK, text: `批注 ${MARK}` })
  const project = await json('POST', '/api/projects', A.token, { name: `项目 ${MARK}` })
  const kbForm = new FormData(); kbForm.append('file', new File([`资料 ${MARK}`], 'notes.txt', { type: 'text/plain' }))
  const kbFile = (await json('POST', '/api/kb', A.token, undefined, kbForm))[0]
  const mem = await json('POST', '/api/memory', A.token, { content: `偏好 ${MARK}`, kind: 'preference' })
  const change = store.addMemoryChange({ owner: A.user.id, action: 'archive', target_ids: [mem.memory.id], content: null, reason: MARK })
  const dsForm = new FormData(); dsForm.append('file', new File(['x'], 'trial.csv'))
  const dataset = (await json('POST', '/api/datasets', A.token, undefined, dsForm))[0]
  await datasets.idle()
  const imgForm = new FormData(); imgForm.append('file', new File([Buffer.from('89504e470d0a1a0a', 'hex')], 'fig.png', { type: 'image/png' }))
  const asset = await json('POST', `/api/docs/${doc.id}/assets`, A.token, undefined, imgForm)
  const invite = await json('POST', '/api/tenant/invites', A.token, {})
  const patient = await json('POST', '/api/patients', A.token, { sex: 'M', tags: [MARK] })
  const lab = await json('POST', `/api/patients/${patient.id}/labs`, A.token, { test_name: MARK, value: 141, unit: 'µmol/L', collected_on: '2025-09-01' })
  const pForm = new FormData(); pForm.append('file', new File([`报告 ${MARK}`], `${MARK}.pdf`, { type: 'application/pdf' })); pForm.append('kind', 'lab_report')
  const pfile = await json('POST', `/api/patients/${patient.id}/files`, A.token, undefined, pForm)
  const proposal = patients.propose({ userId: A.user.id, via: 'ai' }, patient.id, { kind: 'tag', payload: { tag: MARK }, reason: MARK })

  const seed: Seed = {
    doc: doc.id, dataset: dataset.id, kb: kbFile.id, memory: mem.memory.id, comment: comment.id ?? comment.comment?.id ?? 'c0', project: project.id,
    userA: A.user.id, invite: invite.code, tenantA: created.tenant.id, job: 'j-none', turn: 't-none', asset: asset.asset_id, change: change.id,
    patient: patient.id, lab: lab.id, pfile: pfile.file_id, proposal: proposal.id, record: pfile.record.id,
  }
  return { app, store, docs, ops, kb, memory, evolution, datasets, patients, call, seed, A, B, op }
}

describe('越权：每个带参数的接口，别的机构的人带着 A 的 id 都碰不到', () => {
  it('机构 B 的成员与平台运营', async () => {
    const t = await setup()
    // 资产路由的 :id 是资产 id、记忆建议的 :cid 是建议 id——按路径区分
    const valueFor = (path: string, name: string) => {
      if (path.startsWith('/api/assets/') && name === 'id') return t.seed.asset
      if (path.startsWith('/api/memory/changes/') && name === 'cid') return t.seed.change
      if (name === 'action') return path.includes('suggestions') || path.includes('proposals') ? 'accept' : path.includes('changes') ? 'apply' : path.includes('/labs/') || path.includes('/records/') ? 'confirm' : 'resolve'
      return PARAMS[name]!(t.seed)
    }
    const routes = [...new Set(t.app.routes.filter(r => r.path.includes(':') && r.method !== 'ALL').map(r => `${r.method} ${r.path}`))]
    const unknown = routes.flatMap(r => [...r.matchAll(/:(\w+)/g)].map(m => m[1]!).filter(n => !PARAMS[n]).map(n => `${r}（:${n}）`))
    expect(unknown, '新接口的参数要在 PARAMS 里登记用 A 的哪个资源').toEqual([])
    expect(routes.length).toBeGreaterThan(50)

    const leaks: string[] = []
    for (const route of routes) {
      if (PUBLIC[route]) continue
      const [method, pattern] = route.split(' ') as [string, string]
      const path = pattern.replace(/:(\w+)(\{[^}]*\})?/g, (_m, name: string) => encodeURIComponent(valueFor(pattern, name)))
      for (const [who, token] of [['B', t.B.token], ['平台运营', t.op.token]] as const) {
        if (who === '平台运营' && OPERATOR_ALLOWED.has(route)) continue
        const r = await t.call(method, path, token, method === 'GET' || method === 'DELETE' ? undefined : { name: 'x', text: 'x', message: 'x', content: 'x', status: 'disabled', tenant_role: 'member', drop: [], keep: ['note'] })
        if (r.status < 400 || r.text.includes(MARK)) leaks.push(`${who} ${method} ${path} → ${r.status} ${r.text.slice(0, 80)}`)
      }
    }
    expect(leaks).toEqual([])

    // A 自己还能正常访问（防止「全都 404」的假通过）
    expect((await t.call('GET', `/api/docs/${t.seed.doc}/read`, t.A.token)).text).toContain(MARK)
    expect((await t.call('GET', `/api/datasets/${t.seed.dataset}/preview`, t.A.token)).text).toContain(MARK)
    expect((await t.call('GET', `/api/kb/${t.seed.kb}/text`, t.A.token)).status).toBe(200)
    expect((await t.call('GET', `/api/patients/${t.seed.patient}`, t.A.token)).text).toContain(MARK)
    expect((await t.call('GET', `/api/patients/${t.seed.patient}/files/${t.seed.pfile}`, t.A.token)).text).toContain(MARK)
    // 列表接口：B 看不到 A 的任何东西
    for (const p of ['/api/docs', '/api/kb', '/api/memory', '/api/datasets', '/api/projects', '/api/tenant/members', '/api/tenant/audit', '/api/queue', '/api/patients', '/api/patients-directory', '/api/tenant/colleagues']) {
      const r = await t.call('GET', p, t.B.token)
      expect(r.text, `B ${p}`).not.toContain(MARK)
      expect(r.text, `B ${p}`).not.toContain('alice')
      // 审计里会有 B 自己发出的请求带的 id（那是 B 提供的），其余列表不能出现 A 的资源
      if (p !== '/api/tenant/audit') expect(r.text, `B ${p}`).not.toContain(t.seed.doc)
    }
  })
})

describe('越权：MCP 工具，别的机构的 AI 带着 A 的 id 都碰不到', () => {
  /** 工具里带 id 的参数 → A 的资源（新工具的 id 参数必须登记）。 */
  const TOOL_PARAMS: Record<string, (s: Seed) => unknown> = {
    doc_id: s => s.doc, dataset_id: s => s.dataset, file_id: s => s.kb, file_ids: s => [s.kb], memory_ids: s => [s.memory], dataset_ids: s => [s.dataset],
    thread_id: s => s.comment, comment_id: s => s.comment, slide_id: () => 's0', block_id: () => 'b0', ids: () => ['b0'], id: () => 'b0', anchor_id: () => 'b0', node_id: () => 'b0',
    cite_id: () => 'c0', asset_id: s => s.asset, project: s => s.project, patient_id: s => s.patient, section_id: () => 'b0', slide_ids: () => ['s0'], from_id: () => 'b0', to_id: () => 'b0', claim_id: () => 'k0',
  }

  it('机构 B 的令牌调用每个带 id 的工具', async () => {
    const t = await setup()
    const connect = async (userId: string) => {
    const claims = verifyToken(SECRET, issueToken(SECRET, { u: userId, d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 60 }), 'mcp')!
    const server = buildMcpServer({
      docs: t.docs, ops: t.ops, turns: new TurnRegistry(), secret: SECRET, claims: new ClaimService(t.docs, {} as PubMedClient), renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'iso-r2-'))),
      pubmed: {} as PubMedClient, crossref: {} as CrossrefClient, workspaceDir: () => mkdtempSync(join(tmpdir(), 'iso-mws-')), isLiveSession: () => true,
      kb: t.kb, memory: t.memory, evolution: t.evolution, datasets: t.datasets, patients: t.patients,
    }, claims)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'iso', version: '0' })
    await client.connect(b)
    return client
    }
    const text = (r: unknown) => (r as { content: Array<{ text?: string }> }).content.map(c => c.text ?? '').join('')
    // 正向对照：A 自己能读到暗号（证明下面的「读不到」不是因为测试本身读不到任何东西）
    const own = await connect(t.A.user.id)
    expect(text(await own.callTool({ name: 'doc_read', arguments: { doc_id: t.seed.doc } }))).toContain(MARK)
    expect(text(await own.callTool({ name: 'dataset_describe', arguments: { dataset_id: t.seed.dataset } }))).toContain(MARK)
    expect(text(await own.callTool({ name: 'kb_read', arguments: { file_id: t.seed.kb } }))).toContain(MARK)
    expect(text(await own.callTool({ name: 'patient_read', arguments: { patient_id: t.seed.patient } }))).toContain(MARK)
    expect(text(await own.callTool({ name: 'labs_query', arguments: { patient_id: t.seed.patient } }))).toContain(MARK)

    const client = await connect(t.B.user.id)
    const { tools } = await client.listTools()
    const idish = (k: string) => /(^id$|_id$|_ids$|^ids$|^project$)/.test(k)
    const unknown = tools.flatMap(tool => Object.keys((tool.inputSchema as any).properties ?? {}).filter(k => idish(k) && !TOOL_PARAMS[k]).map(k => `${tool.name}.${k}`))
    expect(unknown, '新工具的 id 参数要在 TOOL_PARAMS 里登记').toEqual([])

    const leaks: string[] = []
    let tried = 0
    for (const tool of tools) {
      const props = (tool.inputSchema as any).properties ?? {}
      const keys = Object.keys(props).filter(idish)
      if (keys.length === 0) continue
      tried++
      const args: Record<string, unknown> = {}
      for (const k of keys) args[k] = TOOL_PARAMS[k]!(t.seed)
      // 其他必填参数给个占位值（只为走到归属检查）
      for (const k of ((tool.inputSchema as any).required ?? []) as string[]) if (!(k in args)) args[k] = props[k]?.type === 'array' ? [] : props[k]?.type === 'number' || props[k]?.type === 'integer' ? 1 : props[k]?.type === 'boolean' ? false : props[k]?.type === 'object' ? {} : 'x'
      const r = await client.callTool({ name: tool.name, arguments: args }).catch(err => ({ isError: true, content: [{ text: String(err) }] })) as { isError?: boolean; content: Array<{ text?: string }> }
      const text = r.content.map(c => c.text ?? '').join('')
      if (text.includes(MARK)) leaks.push(`${tool.name} ${JSON.stringify(args)} → ${text.slice(0, 120)}`)
    }
    expect(leaks).toEqual([])
    expect(tried).toBeGreaterThan(20)
  })
})
