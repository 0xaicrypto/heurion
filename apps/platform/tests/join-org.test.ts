import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { BotGuard, solveChallenge, type Challenge } from '../src/auth/bot-guard.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { TurnService } from '../src/turns/service.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService } from '../src/tenancy/patients.ts'

/**
 * 已有账户加入医院，个人空间保留（双重身份，docs/design/TENANCY.md）：
 * 按用户名邀请 → 本人接受 / 拒绝；工作台按工作空间、知家按个人空间，互不串；退出 / 移出回到个人空间。
 */

const SECRET = 'test-secret'
const PERSONAL = { 'X-Heurion-Space': 'personal' }

async function setup(dbPath = ':memory:') {
  const store = new Store(dbPath)
  const docs = new Documents(store)
  const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {}, workspaceDir: () => mkdtempSync(join(tmpdir(), 'join-ws-')) } as unknown as HarnessPool
  const accounts = new Accounts(store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: SECRET, baseMax: 300, minDelayMs: 0 }) })
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'join-pt-')), new TenantService(store, { devMode: false }), new TenantKeys(store, kekFrom({ secret: SECRET })), store,
    null, ({ owner, title }) => docs.create({ owner, title }).id)
  const turns = new TurnService(docs, pool, new TurnRegistry(), { memory: undefined })
  const ops = new OpService(docs, (owner, pid) => patients.memberMarkers(owner, pid))
  const app = buildApi({
    docs, ops, turns, postcheck: new PostCheck(docs), crossref: {} as CrossrefClient,
    renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'join-r-'))), accounts, devMode: false, devUser: 'dev', patients,
  })
  const call = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
    if (/^\/api\/auth\/(register|login)$/.test(path)) body = { ...(body as object), pow: solveChallenge((await (await app.request('/api/auth/challenge')).json()) as Challenge) }
    const res = await app.request(path, {
      method,
      headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, text: await res.text() }
  }
  const json = async (...args: Parameters<typeof call>) => JSON.parse((await call(...args)).text)
  const register = (username: string, invite?: string) => json('POST', '/api/auth/register', undefined, { username, password: 'passw0rd123', ...(invite ? { invite } : {}) })
  // 平台运营建医院，管理员经邀请注册；医生王是先在知家注册的个人账户
  const op = await register('op')
  const created = await json('POST', '/api/platform/tenants', op.token, { name: '省立医院' })
  const admin = await register('hadmin', created.invite.code)
  const wang = await register('drwang')
  return { store, app, call, json, register, op, admin, wang, hospital: created.tenant.id as string }
}

describe('已有账户加入医院（双重身份）', () => {
  it('按用户名邀请 → 本人在「发给我的邀请」里看到并接受；工作台换成医院，知家的家人档案还在', async () => {
    const t = await setup()
    // 王医生先在知家给妈妈建档
    const mom = await t.json('POST', '/api/patients', t.wang.token, { name: '妈妈', sex: 'F', birth_year: 1960 }, PERSONAL)
    expect(mom.name).toBe('妈妈')
    const inv = await t.json('POST', '/api/tenant/invites', t.admin.token, { username: 'drwang' })
    expect(inv.target_user_id).toBe(t.wang.user.id)
    const mine = await t.json('GET', '/api/me/invites', t.wang.token)
    expect(mine).toEqual([expect.objectContaining({ code: inv.code, tenant: '省立医院', role: 'member' })])
    // 别人拿到这个码也接受不了、看不到
    const other = await t.register('drli')
    expect((await t.call('GET', `/api/me/invites/${inv.code}`, other.token)).status).toBe(404)
    expect((await t.call('POST', `/api/me/invites/${inv.code}/accept`, other.token)).status).toBe(404)
    // 也不能拿去注册新账户
    expect((await t.call('POST', '/api/auth/register', undefined, { username: 'sneaky', password: 'passw0rd123', invite: inv.code })).status).toBe(400)
    // 本人接受
    const view = await t.json('POST', `/api/me/invites/${inv.code}/accept`, t.wang.token)
    expect(view).toMatchObject({ id: t.hospital, kind: 'org', role: 'member', in_org: true })
    expect(view.personal_id).toBeTruthy()
    const me = await t.json('GET', '/api/me', t.wang.token)
    expect(me.tenant.id).toBe(t.hospital)
    // 工作台（工作空间 = 医院）看不到妈妈；知家（个人空间）照旧
    expect((await t.json('GET', '/api/patients', t.wang.token)).map((p: { id: string }) => p.id)).not.toContain(mom.id)
    expect((await t.json('GET', '/api/patients', t.wang.token, undefined, PERSONAL)).map((p: { id: string }) => p.id)).toEqual([mom.id])
    // 医院建的患者不会出现在知家
    const hp = await t.json('POST', '/api/patients', t.wang.token, { sex: 'M' })
    expect((await t.json('GET', '/api/patients', t.wang.token, undefined, PERSONAL)).map((p: { id: string }) => p.id)).not.toContain(hp.id)
    // 管理员现在能把他分进科室；审计里有加入记录
    const dept = await t.json('POST', '/api/tenant/departments', t.admin.token, { name: '心内科' })
    const set = await t.call('PUT', `/api/tenant/departments/${dept.id}/members`, t.admin.token, { user_ids: [t.wang.user.id] })
    expect(set.status).toBe(200)
    expect(t.store.listAudit({ tenant: t.hospital }).map(a => a.action)).toContain('tenant.join')
  })

  it('加入后能收到发给科室的家庭分享；他自己的知家仍能分享给别的医院', async () => {
    const t = await setup()
    const inv = await t.json('POST', '/api/tenant/invites', t.admin.token, { username: 'drwang' })
    await t.json('POST', `/api/me/invites/${inv.code}/accept`, t.wang.token)
    const dept = await t.json('POST', '/api/tenant/departments', t.admin.token, { name: '心内科' })
    await t.json('PUT', `/api/tenant/departments/${dept.id}/members`, t.admin.token, { user_ids: [t.wang.user.id] })
    const fam = await t.register('family')
    const p = await t.json('POST', '/api/patients', fam.token, { name: '爸爸', sex: 'M', birth_year: 1955 }, PERSONAL)
    const sh = await t.json('POST', `/api/phr/${p.id}/shares`, fam.token, { tenant_id: t.hospital, department_id: dept.id })
    expect(sh.id).toBeTruthy()
    expect((await t.json('GET', '/api/shares', t.wang.token)).map((s: { share_id: string }) => s.share_id)).toEqual([sh.id])
    // 王医生的知家（个人空间）仍是分享的来源一方
    const mom = await t.json('POST', '/api/patients', t.wang.token, { name: '妈妈' }, PERSONAL)
    const own = await t.json('POST', `/api/phr/${mom.id}/shares`, t.wang.token, { tenant_id: t.hospital, department_id: dept.id })
    expect(own.id).toBeTruthy()
  })

  it('拒绝；已在别的医院不能再被邀请 / 接受；过期与撤销的邀请无效', async () => {
    const t = await setup()
    const inv = await t.json('POST', '/api/tenant/invites', t.admin.token, { username: 'drwang' })
    expect((await t.call('POST', `/api/me/invites/${inv.code}/decline`, t.wang.token)).status).toBe(200)
    expect(await t.json('GET', '/api/me/invites', t.wang.token)).toEqual([])
    expect((await t.call('POST', `/api/me/invites/${inv.code}/accept`, t.wang.token)).status).toBe(404)
    // 撤销的邀请
    const inv2 = await t.json('POST', '/api/tenant/invites', t.admin.token, { username: 'drwang' })
    await t.call('DELETE', `/api/tenant/invites/${inv2.code}`, t.admin.token)
    expect((await t.call('POST', `/api/me/invites/${inv2.code}/accept`, t.wang.token)).status).toBe(404)
    // 过期的邀请
    const inv3 = await t.json('POST', '/api/tenant/invites', t.admin.token, { username: 'drwang' })
    ;(t.store as unknown as { db: DatabaseSync }).db.prepare('UPDATE tenant_invites SET expires_at = ? WHERE code = ?').run('2000-01-01T00:00:00.000Z', inv3.code)
    expect((await t.call('POST', `/api/me/invites/${inv3.code}/accept`, t.wang.token)).status).toBe(400)
    // 已在另一家医院：邀请发不出去，链接邀请也接受不了
    const other = await t.json('POST', '/api/platform/tenants', t.op.token, { name: '市立医院' })
    const admin2 = await t.register('hadmin2', other.invite.code)
    const link = await t.json('POST', '/api/tenant/invites', t.admin.token, {})
    expect((await t.call('POST', `/api/me/invites/${link.code}/accept`, admin2.token)).status).toBe(409)
    expect((await t.call('POST', '/api/tenant/invites', t.admin.token, { username: 'hadmin2' })).status).toBe(409)
    // 已有个人账户拿链接邀请也能加入
    expect((await t.json('POST', `/api/me/invites/${link.code}/accept`, t.wang.token)).id).toBe(t.hospital)
  })

  it('退出 / 移出：负责本院研究的要先转交；退出后回到个人空间，科室归属去掉，知家不受影响', async () => {
    const t = await setup()
    const mom = await t.json('POST', '/api/patients', t.wang.token, { name: '妈妈' }, PERSONAL)
    const inv = await t.json('POST', '/api/tenant/invites', t.admin.token, { username: 'drwang' })
    await t.json('POST', `/api/me/invites/${inv.code}/accept`, t.wang.token)
    const dept = await t.json('POST', '/api/tenant/departments', t.admin.token, { name: '心内科' })
    await t.json('PUT', `/api/tenant/departments/${dept.id}/members`, t.admin.token, { user_ids: [t.wang.user.id] })
    const study = t.store.addStudy({ owner: t.wang.user.id, title: '心衰随访', design: null, status: 'planning', summary: null })
    const blocked = await t.call('POST', '/api/tenant/leave', t.wang.token)
    expect(blocked.status).toBe(409)
    expect(blocked.text).toContain('心衰随访')
    t.store.deleteStudy(study.id)
    const view = await t.json('POST', '/api/tenant/leave', t.wang.token)
    expect(view).toMatchObject({ kind: 'personal', in_org: false })
    expect(t.store.departmentsOfUser(t.wang.user.id)).toEqual([])
    expect((await t.json('GET', '/api/patients', t.wang.token, undefined, PERSONAL)).map((p: { id: string }) => p.id)).toEqual([mom.id])
    // 工作空间回到个人空间：工作台也看得到妈妈
    expect((await t.json('GET', '/api/patients', t.wang.token)).map((p: { id: string }) => p.id)).toEqual([mom.id])
    expect(t.store.listAudit({}).map(a => a.action)).toContain('tenant.leave')
    // 管理员移出：同样回到个人空间；不能移出自己、不能移出别院的人
    const inv2 = await t.json('POST', '/api/tenant/invites', t.admin.token, { username: 'drwang' })
    await t.json('POST', `/api/me/invites/${inv2.code}/accept`, t.wang.token)
    expect((await t.call('DELETE', `/api/tenant/members/${t.admin.user.id}`, t.admin.token)).status).toBe(400)
    expect((await t.call('DELETE', `/api/tenant/members/${t.op.user.id}`, t.admin.token)).status).toBe(404)
    expect((await t.call('DELETE', `/api/tenant/members/${t.wang.user.id}`, t.wang.token)).status).toBe(403)
    expect((await t.call('DELETE', `/api/tenant/members/${t.wang.user.id}`, t.admin.token)).status).toBe(200)
    expect((await t.json('GET', '/api/me', t.wang.token)).tenant).toMatchObject({ kind: 'personal', in_org: false })
    // 本院唯一管理员不能退出
    expect((await t.call('POST', '/api/tenant/leave', t.admin.token)).status).toBe(409)
  })

  it('管理员越权读不到成员的个人空间；知家请求读不到医院患者，工作台请求读不到个人空间患者', async () => {
    const t = await setup()
    const mom = await t.json('POST', '/api/patients', t.wang.token, { name: '妈妈' }, PERSONAL)
    const inv = await t.json('POST', '/api/tenant/invites', t.admin.token, { username: 'drwang' })
    await t.json('POST', `/api/me/invites/${inv.code}/accept`, t.wang.token)
    const hp = await t.json('POST', '/api/patients', t.wang.token, { sex: 'M' })
    // 管理员：工作台和知家都读不到王医生的妈妈
    for (const h of [{}, PERSONAL]) expect((await t.call('GET', `/api/patients/${mom.id}`, t.admin.token, undefined, h)).status).toBe(404)
    // 王医生自己：知家读不到医院患者，工作台读不到妈妈
    expect((await t.call('GET', `/api/patients/${hp.id}`, t.wang.token, undefined, PERSONAL)).status).toBe(404)
    expect((await t.call('GET', `/api/patients/${mom.id}`, t.wang.token)).status).toBe(404)
    // /api/phr/* 一律按个人空间（AI 经确认卡调用时不带请求头也一样）
    expect((await t.call('GET', `/api/phr/${mom.id}/shares`, t.wang.token)).status).toBe(200)
    expect((await t.call('GET', `/api/phr/${hp.id}/shares`, t.wang.token)).status).toBe(404)
  })

  it('知家文档记下空间：健康档案的归属写明 personal 与个人空间的租户（AI 回合按它取空间）', async () => {
    const t = await setup()
    const inv = await t.json('POST', '/api/tenant/invites', t.admin.token, { username: 'drwang' })
    await t.json('POST', `/api/me/invites/${inv.code}/accept`, t.wang.token)
    const mom = await t.json('POST', '/api/patients', t.wang.token, { name: '妈妈' }, PERSONAL)
    const arch = await t.json('POST', `/api/phr/${mom.id}/archive`, t.wang.token, {})
    const ctx = JSON.parse(t.store.getDoc(arch.doc_id)!.context!)
    expect(ctx).toMatchObject({ kind: 'patient', doc_kind: 'archive', space: 'personal' })
    expect(ctx.tenant_id).toBe(t.store.getUser(t.wang.user.id)!.personal_tenant_id)
  })

  it('迁移：老库里个人租户的账户补上个人空间；经邀请注册的纯医院账号第一次用知家时建一个', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'join-mig-')), 'p.db')
    const t = await setup(file)
    // 模拟老库：去掉新列
    const raw = new DatabaseSync(file)
    raw.exec('ALTER TABLE users DROP COLUMN personal_tenant_id')
    raw.close()
    const store = new Store(file)
    expect(store.getUser(t.wang.user.id)!.personal_tenant_id).toBe(store.getUser(t.wang.user.id)!.tenant_id)
    expect(store.getUser(t.admin.user.id)!.personal_tenant_id).toBeNull()
    const tenants = new TenantService(store, { devMode: false })
    const home = tenants.personalOf(t.admin.user.id)
    expect(home.kind).toBe('personal')
    expect(store.getUser(t.admin.user.id)!.personal_tenant_id).toBe(home.id)
    expect(store.getUser(t.admin.user.id)!.tenant_id).toBe(t.hospital)
  })
})
