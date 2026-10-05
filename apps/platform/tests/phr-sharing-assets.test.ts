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
import type { CrossrefClient } from '../src/literature/crossref.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { parseBlocks } from '../src/model/markdown.ts'
import { schema } from '../src/model/schema.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService } from '../src/tenancy/patients.ts'
import { ShareService } from '../src/tenancy/shares.ts'
import { TurnService } from '../src/turns/service.ts'

const SECRET = 'test-secret'

async function setup() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {}, workspaceDir: () => mkdtempSync(join(tmpdir(), 'sh-ws-')) } as unknown as HarnessPool
  const accounts = new Accounts(store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: SECRET, baseMax: 300, minDelayMs: 0 }) })
  ;(accounts as unknown as { registerLimit: { hit: () => boolean } }).registerLimit = { hit: () => false }
  const tenants = new TenantService(store, { devMode: false })
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'sh-pt-')), tenants, new TenantKeys(store, kekFrom({ secret: SECRET })), store, null,
    ({ owner, title }) => docs.create({ owner, title }).id)
  const shares = new ShareService(store, tenants, patients, docs)
  const ops = new OpService(docs)
  const app = buildApi({
    docs, ops, turns: new TurnService(docs, pool, new TurnRegistry()), postcheck: new PostCheck(docs), crossref: {} as CrossrefClient,
    renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'sh-r-'))), accounts, devMode: false, devUser: 'dev', patients, shares,
  })
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    if (/^\/api\/auth\/register$/.test(path)) body = { ...(body as object), pow: solveChallenge((await (await app.request('/api/auth/challenge')).json()) as Challenge) }
    const res = await app.request(path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: res.status, json, text, headers: res.headers }
  }
  const register = async (username: string, invite?: string) => (await call('POST', '/api/auth/register', undefined, { username, password: 'passw0rd123', ...(invite ? { invite } : {}) })).json
  const op = await register('operator')

  // 1. 机构与科室设置
  const orgA = (await call('POST', '/api/platform/tenants', op.token, { name: '协和医院' })).json
  const hospAdmin = await register('hosp_admin', orgA.invite.code)
  const deptRes = await call('POST', '/api/tenant/departments', hospAdmin.token, { name: '心内科' })
  const deptId = deptRes.json.id

  // 2. 医生注册并加入心内科
  const inviteRes = await call('POST', '/api/tenant/invites', hospAdmin.token, { role: 'doctor' })
  const doctor = await register('doctor_cardio', inviteRes.json.code)
  await call('PUT', `/api/tenant/departments/${deptId}/members`, hospAdmin.token, { user_ids: [doctor.user.id] })

  // 3. 另一家医院的医生（未授权）
  const orgB = (await call('POST', '/api/platform/tenants', op.token, { name: '别的医院' })).json
  const otherHospAdmin = await register('other_admin', orgB.invite.code)
  const otherInvite = await call('POST', '/api/tenant/invites', otherHospAdmin.token, { role: 'doctor' })
  const otherDoctor = await register('other_doc', otherInvite.json.code)

  // 4. 家人在知家（个人空间）建档
  const family = await register('family_user')
  const pRes = await call('POST', '/api/patients', family.token, { name: '妈妈', sex: 'F', birth_year: 1965 })
  const patientId = pRes.json.id

  return { store, docs, patients, app, call, hospTenant: orgA.tenant, deptId, doctor, otherDoctor, family, patientId }
}

describe('知家分享原件图片跨空间调阅 (Track C - SHARING.md §6)', () => {
  it('科室医生能通过分享安全调阅文档中的图片原件，非授权人员 404', async () => {
    const { store, docs, patients, call, hospTenant, deptId, doctor, otherDoctor, family, patientId } = await setup()

    // 1. 家人上传图片并建立带图片的健康档案文档
    const imgBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // PNG header
    const asset = store.putAsset({ owner: family.user.id, mime: 'image/png', name: 'chest_xray.png', bytes: imgBytes })

    // 未分享的另一张家人私有照片
    const privateAsset = store.putAsset({ owner: family.user.id, mime: 'image/png', name: 'private_family.png', bytes: imgBytes })

    // 创建健康档案文档，内嵌该图片
    const docNode = schema.node('doc', null, [
      ...parseBlocks('# 妈妈健康档案\n以下是心电图与胸片'),
      schema.node('figure', { asset_id: asset.id, alt: '胸部X光片' }),
    ])
    const doc = docs.create({ owner: family.user.id, title: '妈妈健康档案', content: docNode })

    // 关联到患者档案
    await call('POST', `/api/patients/${patientId}/docs`, family.token, { doc_id: doc.id, kind: 'archive' })

    // 2. 家人分享给协和医院心内科
    const shareRes = await call('POST', `/api/phr/${patientId}/shares`, family.token, {
      tenant_id: hospTenant.id,
      department_id: deptId,
      days: 30,
      scope: { categories: ['labs', 'reports', 'docs'] },
    })
    expect(shareRes.status).toBe(201)
    const shareId = shareRes.json.id

    // 3. 医生查看文档 HTML
    const docRes = await call('GET', `/api/shares/${shareId}/docs/${doc.id}`, doctor.token)
    expect(docRes.status).toBe(200)
    expect(docRes.json.html).toContain(`/api/shares/${shareId}/assets/${asset.id}`)

    // 4. 目标医生调阅图片原件
    const assetRes = await call('GET', `/api/shares/${shareId}/assets/${asset.id}`, doctor.token)
    expect(assetRes.status).toBe(200)
    expect(assetRes.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(Buffer.from(assetRes.text, 'binary')).length).toBeGreaterThan(0)

    // 5. 检查家人端的访问审计日志
    const logs = patients.accessLog({ userId: family.user.id, via: 'user' }, patientId)
    // 应该记录了 share_doc 和 share_asset
    expect(logs.some(l => l.action === 'share_asset')).toBe(true)

    // 6. 跨租户 / 未授权防越权防御：
    // - 别家医院的医生访问该分享图片 -> 404
    const otherRes = await call('GET', `/api/shares/${shareId}/assets/${asset.id}`, otherDoctor.token)
    expect(otherRes.status).toBe(404)

    // - 医生试图通过合法 shareId 读取家人未在文档中分享的私有图片 privateAsset -> 404
    const unsharedRes = await call('GET', `/api/shares/${shareId}/assets/${privateAsset.id}`, doctor.token)
    expect(unsharedRes.status).toBe(404)

    // 7. 撤销分享后立即失效
    await call('DELETE', `/api/phr/shares/${shareId}`, family.token)
    const revokedRes = await call('GET', `/api/shares/${shareId}/assets/${asset.id}`, doctor.token)
    expect(revokedRes.status).toBe(404)
  })
})
