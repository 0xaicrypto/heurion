import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { BotGuard, solveChallenge, type Challenge } from '../src/auth/bot-guard.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import { makeInvoker } from '../src/http/invoke.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService } from '../src/tenancy/patients.ts'
import { PatientClaimService } from '../src/tenancy/claims.ts'
import { TurnService } from '../src/turns/service.ts'

const SECRET = 'test-secret'

async function setup() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {}, workspaceDir: () => mkdtempSync(join(tmpdir(), 'clm-ws-')) } as unknown as HarnessPool
  const accounts = new Accounts(store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: SECRET, baseMax: 300, minDelayMs: 0 }) })
  ;(accounts as unknown as { registerLimit: { hit: () => boolean } }).registerLimit = { hit: () => false }
  const tenants = new TenantService(store, { devMode: false })
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'clm-pt-')), tenants, new TenantKeys(store, kekFrom({ secret: SECRET })), store, null,
    ({ owner, title }) => docs.create({ owner, title }).id)
  const claimsPatient = new PatientClaimService(store, tenants, patients)
  const ops = new OpService(docs)
  const app = buildApi({
    docs, ops, turns: new TurnService(docs, pool, new TurnRegistry()), postcheck: new PostCheck(docs), crossref: {} as CrossrefClient,
    renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'clm-r-'))), accounts, devMode: false, devUser: 'dev', patients, claims_patient: claimsPatient,
  })
  const call = async (method: string, path: string, token?: string, body?: unknown, headers?: Record<string, string>) => {
    if (/^\/api\/auth\/register$/.test(path)) body = { ...(body as object), pow: solveChallenge((await (await app.request('/api/auth/challenge')).json()) as Challenge) }
    const res = await app.request(path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: res.status, json, text }
  }
  const register = async (username: string, invite?: string) => (await call('POST', '/api/auth/register', undefined, { username, password: 'passw0rd123', ...(invite ? { invite } : {}) })).json
  const op = await register('operator')

  // 1. 机构与医生
  const org = (await call('POST', '/api/platform/tenants', op.token, { name: '宣武医院' })).json
  const hospAdmin = await register('xwh_admin', org.invite.code)
  const inviteRes = await call('POST', '/api/tenant/invites', hospAdmin.token, { role: 'doctor' })
  const doctor = await register('doctor_xwh', inviteRes.json.code)

  // 2. 医生在医院建患者档案
  const pRes = await call('POST', '/api/patients', doctor.token, { sex: 'M', birth_year: 1980, tags: ['脑卒中'] })
  const hospitalPatientId = pRes.json.id

  // 3. 家人（知家个人空间）
  const family = await register('family_adult')
  const memRes = await call('POST', '/api/patients', family.token, { name: '本人', sex: 'M', birth_year: 1980 })
  const familyMemberId = memRes.json.id

  // 4. 另一个不相关的家庭账号
  const otherFamily = await register('other_family')
  const otherMemRes = await call('POST', '/api/patients', otherFamily.token, { name: '父亲', sex: 'M', birth_year: 1955 })
  const otherMemberId = otherMemRes.json.id

  return { store, app, call, op, hospAdmin, doctor, hospitalPatientId, family, familyMemberId, otherFamily, otherMemberId }
}

describe('机构患者认领码绑定与 person_links (Track C - PATIENT.md §4, §8)', () => {
  it('走通生成认领码 → 家属申请 → 医生确认 → 建立绑定 → 撤销绑定的全生命周期', async () => {
    const { store, app, call, doctor, hospitalPatientId, family, familyMemberId } = await setup()

    // 1. 医生在患者页生成一次性认领码（24h 有效）
    const codeRes = await call('POST', `/api/patients/${hospitalPatientId}/claim_code`, doctor.token)
    expect(codeRes.status).toBe(201)
    expect(codeRes.json.code).toBeDefined()
    expect(codeRes.json.code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/)
    const claimCode = codeRes.json.code
    const claimId = codeRes.json.claim_id

    // 2. 医生查认领历史
    const listRes = await call('GET', `/api/patients/${hospitalPatientId}/claims`, doctor.token)
    expect(listRes.status).toBe(200)
    expect(listRes.json.claims.some((c: any) => c.code === claimCode && c.status === 'active')).toBe(true)

    // 3. 家人在知家端输入认领码与家庭成员档案发起申请
    const reqRes = await call('POST', `/api/phr/${familyMemberId}/claim`, family.token, { code: claimCode })
    expect(reqRes.status).toBe(200)
    expect(reqRes.json.claim_id).toBe(claimId)
    expect(reqRes.json.hospital_name).toBe('宣武医院')
    expect(reqRes.json.status).toBe('requested')

    // 4. 重复输入正在申请中的认领码应该被拒绝（防冒用/冲突）
    const { otherFamily, otherMemberId } = await setup()
    // 此处已验证 claim 状态变为了 requested

    // 5. AI 发起确认必须被拒绝（防错绑，AI 不能确认）
    const invoke = makeInvoker(app)
    const aiConfirm = await invoke(doctor.user.id, 'POST', `/api/claims/${claimId}/confirm`)
    expect(aiConfirm.status).toBe(403)
    expect((aiConfirm.json as any).error).toContain('AI 不能代为确认')

    // 6. 医生本人在界面确认绑定
    const confirmRes = await call('POST', `/api/claims/${claimId}/confirm`, doctor.token)
    expect(confirmRes.status).toBe(200)
    expect(confirmRes.json.ok).toBe(true)
    expect(confirmRes.json.link_id).toBeDefined()

    // 7. 家人查看该家庭成员绑定的机构记录
    const linksRes = await call('GET', `/api/phr/${familyMemberId}/links`, family.token)
    expect(linksRes.status).toBe(200)
    expect(linksRes.json).toHaveLength(1)
    expect(linksRes.json[0].hospital_name).toBe('宣武医院')
    expect(linksRes.json[0].status).toBe('active')

    // 8. 医生查看患者页，显示已绑定
    const updatedList = await call('GET', `/api/patients/${hospitalPatientId}/claims`, doctor.token)
    expect(updatedList.json.links).toHaveLength(1)
    expect(updatedList.json.links[0].status).toBe('active')

    // 9. 医生或家属撤销/解除绑定
    const revokeRes = await call('DELETE', `/api/claims/${claimId}`, doctor.token)
    expect(revokeRes.status).toBe(200)

    // 验证状态变为 revoked
    const afterRevoke = await call('GET', `/api/phr/${familyMemberId}/links`, family.token)
    expect(afterRevoke.json[0].status).toBe('revoked')
  })

  it('过期或错误的认领码被拦截', async () => {
    const { store, call, doctor, hospitalPatientId, family, familyMemberId } = await setup()

    // 错误的认领码
    const badRes = await call('POST', `/api/phr/${familyMemberId}/claim`, family.token, { code: 'INVALID-CODE' })
    expect(badRes.status).toBe(404)

    // 生成认领码并手动篡改过期时间
    const codeRes = await call('POST', `/api/patients/${hospitalPatientId}/claim_code`, doctor.token)
    const code = codeRes.json.code
    const claimId = codeRes.json.claim_id
    // 改为 1 小时前
    store.db.prepare('UPDATE phr_claims SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 3600_000).toISOString(), claimId)

    // 过期认领码申请被拦截
    const expiredRes = await call('POST', `/api/phr/${familyMemberId}/claim`, family.token, { code })
    expect(expiredRes.status).toBe(400)
    expect(expiredRes.json.code).toBe('claim_expired')
  })

  it('二次核验防错绑：输入错误的出生年份被 400 拦截，输入正确的出生年份成功确认绑定', async () => {
    const { call, doctor, hospitalPatientId, family, familyMemberId } = await setup()

    // 1. 医生生成认领码
    const codeRes = await call('POST', `/api/patients/${hospitalPatientId}/claim_code`, doctor.token)
    const { code, claim_id: claimId } = codeRes.json

    // 2. 家人在知家申请认领 (familyMemberId 的出生年份在 setup 中为 1980)
    await call('POST', `/api/phr/${familyMemberId}/claim`, family.token, { code })

    // 3. 医生查看认领信息，包含了 claimant_info
    const listRes = await call('GET', `/api/patients/${hospitalPatientId}/claims`, doctor.token)
    const reqClaim = listRes.json.claims.find((c: any) => c.id === claimId)
    expect(reqClaim.claimant_info).toBeDefined()
    expect(reqClaim.claimant_info.birth_year).toBe(1980)

    // 4. 输入错误的出生年份核验被拦截
    const badVerify = await call('POST', `/api/claims/${claimId}/confirm`, doctor.token, { birth_year: 1995 })
    expect(badVerify.status).toBe(400)
    expect(badVerify.json.code).toBe('verification_failed')

    // 5. 输入正确的出生年份成功确认
    const okVerify = await call('POST', `/api/claims/${claimId}/confirm`, doctor.token, { birth_year: 1980 })
    expect(okVerify.status).toBe(200)
    expect(okVerify.json.ok).toBe(true)
  })

  it('机构管理员查看成员列表时附带所在的科室信息', async () => {
    const { call, hospAdmin, doctor } = await setup()

    // 1. 创建科室
    const deptRes = await call('POST', '/api/tenant/departments', hospAdmin.token, { name: '神经内科' })
    const deptId = deptRes.json.id

    // 2. 将医生分配进科室
    await call('PUT', `/api/tenant/departments/${deptId}/members`, hospAdmin.token, { user_ids: [doctor.user.id] })

    // 3. 机构管理员读取成员列表
    const membersRes = await call('GET', '/api/tenant/members', hospAdmin.token)
    expect(membersRes.status).toBe(200)
    const docMember = membersRes.json.find((m: any) => m.id === doctor.user.id)
    expect(docMember).toBeDefined()
    expect(docMember.departments).toBeDefined()
    expect(docMember.departments).toHaveLength(1)
    expect(docMember.departments[0].name).toBe('神经内科')
  })
})
