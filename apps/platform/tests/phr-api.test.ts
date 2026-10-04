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
import { TenantService } from '../src/auth/tenants.ts'
import { TurnService } from '../src/turns/service.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService } from '../src/tenancy/patients.ts'
import type { EditBatch } from '../src/ops/types.ts'

/**
 * 知家接口（docs/design/PATIENT.md §6、§12）：手动录入只对个人空间、称呼只在个人空间、
 * 健康档案 / 就诊简报的落点与限流、孤儿文档防护。
 */

const SECRET = 'test-secret'

async function setup() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {}, workspaceDir: () => mkdtempSync(join(tmpdir(), 'phr-ws-')) } as unknown as HarnessPool
  const accounts = new Accounts(store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: SECRET, baseMax: 300, minDelayMs: 0 }) })
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'phr-pt-')), new TenantService(store, { devMode: false }), new TenantKeys(store, kekFrom({ secret: SECRET })), store,
    null,
    // 与 index.ts 同样的钩子：成员建档即建健康档案 doc
    ({ owner, title }) => docs.create({ owner, title }).id)
  const turns = new TurnService(docs, pool, new TurnRegistry(), { memory: undefined })
  const ops = new OpService(docs, (owner, pid) => patients.memberMarkers(owner, pid))
  const app = buildApi({
    docs, ops, turns, postcheck: new PostCheck(docs), crossref: {} as CrossrefClient,
    renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'phr-r-'))), accounts, devMode: false, devUser: 'dev', patients,
  })
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    if (/^\/api\/auth\/(register|login)$/.test(path)) body = { ...(body as object), pow: solveChallenge((await (await app.request('/api/auth/challenge')).json()) as Challenge) }
    const res = await app.request(path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, text: await res.text() }
  }
  const json = async (...args: Parameters<typeof call>) => JSON.parse((await call(...args)).text)
  // 第一个注册的是平台运营；不带邀请注册 = 个人租户（知家）；带邀请注册 = 机构租户（医院端）
  const op = await json('POST', '/api/auth/register', undefined, { username: 'op', password: 'passw0rd123' })
  const created = await json('POST', '/api/platform/tenants', op.token, { name: '医院 B' })
  const mom = await json('POST', '/api/auth/register', undefined, { username: 'mom', password: 'passw0rd123' })
  const dr = await json('POST', '/api/auth/register', undefined, { username: 'drb', password: 'passw0rd123', invite: created.invite.code })
  return { store, docs, ops, patients, turns, app, mom, dr, call, json }
}

describe('知家：登录后的家庭空间接口', () => {
  it('称呼只在个人空间：机构端建档传称呼直接拒绝；个人空间正常', async () => {
    const t = await setup()
    const ok = await t.json('POST', '/api/patients', t.mom.token, { name: '妈妈', sex: 'F', birth_year: 1993 })
    expect(ok.name).toBe('妈妈')
    const bad = await t.call('POST', '/api/patients', t.dr.token, { name: '张三', sex: 'M' })
    expect(bad.status).toBe(400)
    expect(bad.text).toContain('医院端患者只用代号')
  })

  it('手动录入化验只对个人空间开放；机构端 403，数值不进研究数据集口径', async () => {
    const t = await setup()
    const p = await t.json('POST', '/api/patients', t.mom.token, { name: '宝宝', birth_year: 2023 })
    const lab = await t.json('POST', `/api/patients/${p.id}/labs`, t.mom.token, { test_name: '空腹血糖', value: 5.2, unit: 'mmol/L', collected_on: '2026-10-01' })
    expect(lab.status).toBe('confirmed')
    expect(lab.source).toBe('manual')
    const drPatient = await t.json('POST', '/api/patients', t.dr.token, { sex: 'M' })
    const denied = await t.call('POST', `/api/patients/${drPatient.id}/labs`, t.dr.token, { test_name: '血糖', value: 5.2, collected_on: '2026-10-01' })
    expect(denied.status).toBe(403)
    expect(denied.text).toContain('只在知家')
  })

  it('「化验 N 次」按化验单份数算：同一天手工录入多项算一次，不同日期各算一次', async () => {
    const t = await setup()
    const p = await t.json('POST', '/api/patients', t.mom.token, { name: '爸爸' })
    for (const [name, v, d] of [['血糖', 5.6, '2026-09-01'], ['肌酐', 80, '2026-09-01'], ['尿酸', 400, '2026-09-01'], ['血糖', 6.1, '2026-10-01']] as const) {
      await t.json('POST', `/api/patients/${p.id}/labs`, t.mom.token, { test_name: name, value: v, collected_on: d })
    }
    const row = (await t.json('GET', '/api/patients', t.mom.token)).find((x: { id: string }) => x.id === p.id)
    expect(row.labs).toBe(4)
    expect(row.lab_reports).toBe(2)
  })

  it('健康档案 doc：建档钩子已建并关联（archive），重复请求返回同一份', async () => {
    const t = await setup()
    const p = await t.json('POST', '/api/patients', t.mom.token, { name: '妈妈' })
    // 建档钩子（与 index.ts 同）在建成员时已经建了健康档案：这里返回已存在的
    const first = await t.json('POST', `/api/phr/${p.id}/archive`, t.mom.token, {})
    expect(first.existed).toBe(true)
    const again = await t.json('POST', `/api/phr/${p.id}/archive`, t.mom.token, {})
    expect(again.existed).toBe(true)
    expect(again.doc_id).toBe(first.doc_id)
    // 文档归属 = 患者的健康档案（守卫的作用域就靠它）
    expect(t.store.getDoc(first.doc_id)!.context).toContain('"doc_kind":"archive"')
  })

  it('就诊简报：建简报文档并排队 AI 回合；30 分钟内同一成员只生成一次', async () => {
    const t = await setup()
    const p = await t.json('POST', '/api/patients', t.mom.token, { name: '妈妈' })
    const brief = await t.json('POST', `/api/phr/${p.id}/brief`, t.mom.token, {})
    expect(brief.doc_id).toBeTruthy()
    expect(t.store.getDoc(brief.doc_id)!.context).toContain('"doc_kind":"brief"')
    // 称呼不进文档标题（AI 读到的 patient_read.previous_reports 与回合指令里都有标题）
    expect(t.store.getDoc(brief.doc_id)!.title).not.toContain('妈妈')
    expect(t.store.getDoc((await t.json('POST', `/api/phr/${p.id}/archive`, t.mom.token, {})).doc_id)!.title).not.toContain('妈妈')
    const dup = await t.call('POST', `/api/phr/${p.id}/brief`, t.mom.token, {})
    expect(dup.status).toBe(409)
    expect(dup.text).toContain('刚生成过简报')
  })

  it('红线守卫在操作层生效：AI 写「考虑为肺炎」整批拒绝；用户写入不受限', async () => {
    const t = await setup()
    const p = await t.json('POST', '/api/patients', t.mom.token, { name: '妈妈' })
    const arch = await t.json('POST', `/api/phr/${p.id}/archive`, t.mom.token, {})
    const anchor = t.docs.get(arch.doc_id).firstChild!.attrs.id as string
    const batch: EditBatch = { doc_id: arch.doc_id, mode: 'apply', base_rev: t.docs.rev(arch.doc_id), ops: [{ op: 'insert_after', anchor_id: anchor, markdown: '考虑为肺炎' }] }
    // AI 的写入（等同 MCP doc_edit 的路径）被患者红线硬闸拦下
    expect(() => t.ops.edit(batch, { actor: 'ai', turnId: null })).toThrow('不能由 AI 给出诊断结论')
    // 用户优先：同样的内容以用户身份写入直接生效
    t.ops.edit({ ...batch, base_rev: t.docs.rev(arch.doc_id) }, { actor: 'user', turnId: null })
    expect(t.docs.get(arch.doc_id).textContent).toContain('考虑为肺炎')
  })
})
