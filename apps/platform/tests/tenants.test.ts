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
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { TurnService } from '../src/turns/service.ts'

const SECRET = 'test-secret'

function env() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {} } as unknown as HarnessPool
  const accounts = new Accounts(store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: SECRET, baseMax: 300, minDelayMs: 0 }) })
  const app = buildApi({
    docs, ops: new OpService(docs), turns: new TurnService(docs, pool, new TurnRegistry()), postcheck: new PostCheck(docs),
    crossref: {} as CrossrefClient, renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'hr-'))), accounts, devMode: false, devUser: 'dev',
  })
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    if (/^\/api\/auth\/(register|login)$/.test(path) && body && typeof body === 'object') {
      body = { ...body, pow: solveChallenge((await (await app.request('/api/auth/challenge')).json()) as Challenge) }
    }
    const res = await app.request(path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let data: any = text
    try { data = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: res.status, data }
  }
  const register = async (username: string, invite?: string) => {
    const r = await call('POST', '/api/auth/register', undefined, { username, password: 'passw0rd123', ...(invite ? { invite } : {}) })
    if (r.status !== 201) throw new Error(`${username}: ${JSON.stringify(r.data)}`)
    return { id: r.data.user.id as string, token: r.data.token as string }
  }
  return { store, call, register }
}

/** 平台运营（第一个注册的用户）建一个机构，首位管理员凭邀请注册加入。 */
async function hospital(t: ReturnType<typeof env>, op: { token: string }, name: string, adminName: string) {
  const created = await t.call('POST', '/api/platform/tenants', op.token, { name })
  expect(created.status).toBe(201)
  const admin = await t.register(adminName, created.data.invite.code)
  return { tenantId: created.data.tenant.id as string, admin }
}

describe('租户：注册、邀请与成员', () => {
  it('个人注册得到个人租户；平台运营建机构，首位管理员凭邀请加入，再邀请成员；邀请只能用一次', async () => {
    const t = env()
    const op = await t.register('operator')
    expect((await t.call('GET', '/api/me', op.token)).data.tenant).toMatchObject({ kind: 'personal', role: 'admin', name: 'operator（个人）' })

    const h = await hospital(t, op, '安徽省立医院心内科', 'dr_wang')
    const me = (await t.call('GET', '/api/me', h.admin.token)).data
    expect(me.tenant).toMatchObject({ id: h.tenantId, name: '安徽省立医院心内科', kind: 'org', role: 'admin' })
    expect(me.role).toBe('user') // 机构管理员不是平台运营

    // 邀请页不需要登录
    const inv = await t.call('POST', '/api/tenant/invites', h.admin.token, { role: 'member', days: 3 })
    expect((await t.call('GET', `/api/invites/${inv.data.code}`)).data).toMatchObject({ tenant: '安徽省立医院心内科', role: 'member' })
    const nurse = await t.register('nurse_li', inv.data.code)
    expect((await t.call('GET', '/api/me', nurse.token)).data.tenant).toMatchObject({ id: h.tenantId, role: 'member' })
    expect((await t.call('GET', `/api/invites/${inv.data.code}`)).status).toBe(409)
    expect((await t.call('POST', '/api/auth/register', undefined, { username: 'again', password: 'passw0rd123', invite: inv.data.code })).status).toBe(400)

    // 撤销的邀请无效；机构成员列表
    const inv2 = await t.call('POST', '/api/tenant/invites', h.admin.token, {})
    expect((await t.call('DELETE', `/api/tenant/invites/${inv2.data.code}`, h.admin.token)).status).toBe(200)
    expect((await t.call('GET', `/api/invites/${inv2.data.code}`)).status).toBe(404)
    expect((await t.call('GET', '/api/tenant/members', h.admin.token)).data.map((m: any) => [m.username, m.tenant_role])).toEqual([['dr_wang', 'admin'], ['nurse_li', 'member']])
  })

  it('成员不能管理；管理员只能管本机构的人；机构不能没有管理员；停用成员令牌立即失效', async () => {
    const t = env()
    const op = await t.register('operator')
    const a = await hospital(t, op, '医院 A', 'admin_a')
    const b = await hospital(t, op, '医院 B', 'admin_b')
    const member = await t.register('member_a', (await t.call('POST', '/api/tenant/invites', a.admin.token, {})).data.code)

    expect((await t.call('GET', '/api/tenant/members', member.token)).status).toBe(403)
    expect((await t.call('POST', '/api/tenant/invites', member.token, {})).status).toBe(403)
    expect((await t.call('PATCH', '/api/tenant', member.token, { name: 'x' })).status).toBe(403)
    // B 的管理员管不到 A 的成员
    expect((await t.call('PATCH', `/api/tenant/members/${member.id}`, b.admin.token, { status: 'disabled' })).status).toBe(404)
    expect((await t.call('PATCH', `/api/tenant/members/${a.admin.id}`, a.admin.token, { tenant_role: 'member' })).status).toBe(409)

    expect((await t.call('PATCH', `/api/tenant/members/${member.id}`, a.admin.token, { status: 'disabled' })).status).toBe(200)
    expect((await t.call('GET', '/api/me', member.token)).status).toBe(401)
    // 平台运营的接口机构管理员调不了
    expect((await t.call('GET', '/api/platform/tenants', a.admin.token)).status).toBe(403)
    expect((await t.call('POST', '/api/platform/tenants', a.admin.token, { name: 'x' })).status).toBe(403)
  })

  it('平台运营停用机构：成员登录被拒、已有令牌失效；恢复后可用；机构设置与本机构审计', async () => {
    const t = env()
    const op = await t.register('operator')
    const a = await hospital(t, op, '医院 A', 'admin_a')
    const b = await hospital(t, op, '医院 B', 'admin_b')

    const set = await t.call('PATCH', '/api/tenant', a.admin.token, { name: '医院 A 心内科', settings: { patient_visibility: 'tenant', external_model_for_patients: false, bogus: 1 } })
    expect(set.data).toMatchObject({ name: '医院 A 心内科', settings: { patient_module: true, patient_visibility: 'tenant', external_model_for_patients: false } })
    expect(set.data.settings.bogus).toBeUndefined()

    // 审计只看本机构
    const auditA = (await t.call('GET', '/api/tenant/audit', a.admin.token)).data.map((r: any) => r.action)
    expect(auditA).toContain('tenant.update')
    expect((await t.call('GET', '/api/tenant/audit', b.admin.token)).data.map((r: any) => r.actor_name)).not.toContain('admin_a')

    expect((await t.call('PATCH', `/api/platform/tenants/${a.tenantId}`, op.token, { status: 'suspended' })).status).toBe(200)
    expect((await t.call('GET', '/api/me', a.admin.token)).status).toBe(401)
    expect((await t.call('POST', '/api/auth/login', undefined, { username: 'admin_a', password: 'passw0rd123' })).data.code).toBe('tenant_suspended')
    expect((await t.call('GET', '/api/me', b.admin.token)).status).toBe(200)
    const list = (await t.call('GET', '/api/platform/tenants', op.token)).data
    expect(list.find((x: any) => x.id === a.tenantId)).toMatchObject({ status: 'suspended', members: 1, admins: 1 })

    expect((await t.call('PATCH', `/api/platform/tenants/${a.tenantId}`, op.token, { status: 'active' })).status).toBe(200)
    expect((await t.call('POST', '/api/auth/login', undefined, { username: 'admin_a', password: 'passw0rd123' })).status).toBe(200)
  })
})

describe('租户：迁移', () => {
  it('租户上线前的用户各得一个个人租户，本人为机构管理员', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hr-mig-')), 'p.db')
    const s1 = new Store(path)
    const u = s1.createUser({ username: 'old', display_name: '老用户', password_hash: 'x' })
    ;(s1 as any).db.prepare('UPDATE users SET tenant_id = NULL, tenant_role = ? WHERE id = ?').run('member', u.id)
    const s2 = new Store(path)
    const migrated = s2.getUser(u.id)!
    expect(migrated.tenant_role).toBe('admin')
    expect(s2.getTenant(migrated.tenant_id!)).toMatchObject({ kind: 'personal', name: '老用户（个人）' })
  })
})
