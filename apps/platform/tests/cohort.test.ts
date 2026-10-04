import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { issueToken, verifyToken } from '../src/auth/token.ts'
import { ClaimService } from '../src/claims/service.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { buildMcpServer } from '../src/mcp/server.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { parseCsv, DatasetService } from '../src/datasets/service.ts'
import type { Ingest } from '../src/datasets/ingest.ts'
import { CohortService } from '../src/research/cohort.ts'
import { StudyService } from '../src/research/service.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { matchCriteria, parseCriteria, PatientService, type Actor } from '../src/tenancy/patients.ts'

/** 假的解析：原样拷贝 CSV，列名里带 id / date 的标成疑似身份信息（检验平台生成的列不被拦）。 */
const ingest: Ingest = async (_owner, src) => {
  const dir = mkdtempSync(join(tmpdir(), 'co-ing-'))
  copyFileSync(src, join(dir, 'data.csv'))
  const recs = parseCsv(readFileSync(src, 'utf8'))
  const header = recs[0] ?? []
  return {
    csv: join(dir, 'data.csv'), cleanup: () => {},
    profile: { ok: true, rows: recs.length - 1, truncated: false, columns: header.map(name => ({ name, type: 'text' as const, missing: 0, unique: 1, ...(/id|date|_on$/.test(name) ? { phi: { reason: '疑似编号 / 日期' } } : {}) })) },
  }
}

function env() {
  const store = new Store(':memory:')
  const tenants = new TenantService(store, { devMode: false })
  const keys = new TenantKeys(store, kekFrom({ secret: 'test-secret' }))
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'co-pt-')), tenants, keys, store)
  const datasets = new DatasetService(store, mkdtempSync(join(tmpdir(), 'co-ds-')), ingest)
  const studies = new StudyService(store, datasets)
  const cohort = new CohortService(studies, patients, datasets)
  const hospA = store.createTenant({ name: '医院 A', kind: 'org' })
  const hospB = store.createTenant({ name: '医院 B', kind: 'org' })
  const user = (name: string, tenant: string, role: 'admin' | 'member' = 'member') => store.createUser({ username: name, display_name: name, password_hash: 'x', tenant: { id: tenant, role } }).id
  const u = { drA: user('drA', hospA.id), nurseA: user('nurseA', hospA.id), adminA: user('adminA', hospA.id, 'admin'), drB: user('drB', hospB.id) }
  const as = (userId: string, via: Actor['via'] = 'user'): Actor => ({ userId, via })
  const year = new Date().getUTCFullYear()
  // drA 的 4 位患者：两位 CKD（一位肌酐高）、一位糖尿病、一位已归档
  const a = as(u.drA)
  const p1 = patients.create(a, { sex: 'M', birth_year: year - 64, tags: ['CKD3', '2型糖尿病'] })
  const p2 = patients.create(a, { sex: 'F', birth_year: year - 58, tags: ['CKD2'] })
  const p3 = patients.create(a, { sex: 'M', birth_year: year - 45, tags: ['2型糖尿病'] })
  const p4 = patients.create(a, { sex: 'M', birth_year: year - 70, tags: ['CKD4'] })
  patients.update(a, p4.id, { status: 'archived' })
  // 化验都挂在能追溯到原件的报告记录上（研究口径：record_id 为空的值不进数据集）
  let reportSeq = 0
  const addReport = (pid: string, date: string, items: Array<Record<string, unknown>>) => {
    const f = patients.addFile(a, pid, { name: `检验报告-${++reportSeq}.pdf`, mime: 'application/pdf', bytes: Uint8Array.from([11, 22, 33, 44, 55, 66, 77, reportSeq]), report_date: date })
    for (const it of items) patients.addRecordLab(a, pid, f.record.id, it)
    patients.resolveRecord(a, pid, f.record.id, { accept: true })
  }
  addReport(p1.id, '2025-03-02', [{ test_name: '肌酐', value: 98, unit: 'µmol/L' }])
  addReport(p1.id, '2025-06-10', [{ test_name: '肌酐', value: 2.1, unit: 'mg/dL' }, { test_name: 'HbA1c', value: 7.2, unit: '%' }]) // 肌酐 185.7 µmol/L
  addReport(p2.id, '2025-01-05', [{ test_name: 'Cr', value: 160, unit: 'µmol/L' }])
  addReport(p2.id, '2025-05-05', [{ test_name: 'Cr', value: 90, unit: 'µmol/L' }])
  addReport(p3.id, '2025-04-01', [{ test_name: '糖化血红蛋白', value: 8.1, unit: '%' }])
  const study = studies.create(u.drA, { title: 'CKD 队列', design: 'retrospective_cohort' })
  return { store, tenants, patients, datasets, studies, cohort, u, as, a, p1, p2, p3, p4, study, year, addReport }
}

describe('研究入组：筛选', () => {
  it('按性别、年龄、标签、化验（标准单位、最近一次 / 任一次）、日期窗口筛选；只看在管的、自己诊疗组里的患者', () => {
    const t = env()
    const codes = (c: unknown) => t.cohort.preview(t.a, t.study.id, c).patients.map(p => p.code)
    expect(codes({})).toEqual(['P-0001', 'P-0002', 'P-0003']) // 归档的 P-0004 不在
    expect(codes({ tags_any: ['ckd'] })).toEqual(['P-0001', 'P-0002'])
    expect(codes({ sex: 'F' })).toEqual(['P-0002'])
    expect(codes({ age_min: 60 })).toEqual(['P-0001'])
    // mg/dL 换算后比较：P-0001 最近一次 185.7 µmol/L
    expect(codes({ labs: [{ test: 'Cr', op: '>', value: 133 }] })).toEqual(['P-0001'])
    // 任一次：P-0002 一月份 160
    expect(codes({ labs: [{ test: '肌酐', mode: 'any', op: '>', value: 133 }] })).toEqual(['P-0001', 'P-0002'])
    // 窗口限定在上半年前段：P-0001 只剩 3 月 98
    expect(codes({ labs: [{ test: '肌酐', mode: 'any', op: '>', value: 133 }], from: '2025-02-01', to: '2025-05-31' })).toEqual([])
    expect(codes({ from: '2025-04-01', to: '2025-04-30' })).toEqual(['P-0003'])
    const r = t.cohort.preview(t.a, t.study.id, { labs: [{ test: 'HbA1c', op: '>=', value: 7 }] })
    expect(r.patients.map(p => [p.code, p.matched.join('；')])).toEqual([['P-0001', 'HbA1c 7.2 %（2025-06-10，最近一次）'], ['P-0003', '糖化血红蛋白 8.1 %（2025-04-01，最近一次）']])
    expect(() => parseCriteria({ labs: [{ test: 'Cr', op: '>>', value: 1 }] })).toThrow('比较符')
    // 不在诊疗组里的同事、别的机构：筛不到 A 的患者
    const nurseStudy = t.studies.create(t.u.nurseA, { title: '护士的研究' })
    expect(t.cohort.preview(t.as(t.u.nurseA), nurseStudy.id, {}).patients).toEqual([])
    const bStudy = t.studies.create(t.u.drB, { title: 'B 的研究' })
    expect(t.cohort.preview(t.as(t.u.drB), bStudy.id, {}).patients).toEqual([])
    // 别人的研究不能用
    expect(() => t.cohort.preview(t.as(t.u.drB), t.study.id, {})).toThrow('研究不存在')
    // 命中的患者记访问日志
    expect(t.patients.accessLog(t.a, t.p1.id).map(l => l.action)).toContain('cohort_screen')
  })

  it('matchCriteria：没有出生年份时年龄条件不匹配', () => {
    const p = { id: 'x', code: 'P-9', name: null, sex: 'M' as const, birth_year: null, tags: [], status: 'active' as const, created_by: '', created_at: '', updated_at: '' }
    expect(matchCriteria(parseCriteria({ age_min: 18 }), p, [], 2026)).toBeNull()
    expect(matchCriteria(parseCriteria({ sex: 'M' }), p, [], 2026)).toEqual(['男'])
  })
})

describe('研究入组：入组、编号、权限', () => {
  it('研究编号研究内递增不复用；移出后再入组恢复原编号；同一患者可入多个研究；患者页显示所在研究', () => {
    const t = env()
    const r = t.cohort.enroll(t.a, t.study.id, { patient_ids: [t.p1.id, t.p2.id, t.p1.id], criteria: { tags_any: ['CKD'] } })
    expect(r.enrolled).toEqual([{ patient_id: t.p1.id, subject_id: 'S001' }, { patient_id: t.p2.id, subject_id: 'S002' }])
    expect(t.cohort.enroll(t.a, t.study.id, { patient_ids: [t.p1.id] }).skipped[0]!.reason).toContain('已入组（S001）')
    t.cohort.unenroll(t.a, t.study.id, t.p1.id)
    expect(t.cohort.enroll(t.a, t.study.id, { patient_ids: [t.p3.id] }).enrolled[0]!.subject_id).toBe('S003')
    expect(t.cohort.enroll(t.a, t.study.id, { patient_ids: [t.p1.id] }).enrolled[0]!.subject_id).toBe('S001')
    const s2 = t.studies.create(t.u.drA, { title: '糖尿病研究' })
    expect(t.cohort.enroll(t.a, s2.id, { patient_ids: [t.p1.id] }).enrolled[0]!.subject_id).toBe('S001')
    expect(t.patients.read(t.a, t.p1.id).studies.map(s => [s.title, s.subject_id])).toEqual([['CKD 队列', 'S001'], ['糖尿病研究', 'S001']])
    const list = t.cohort.list(t.a, t.study.id)
    expect(list.active).toBe(3)
    expect(list.subjects.map(s => [s.subject_id, s.code, s.status])).toEqual([['S001', 'P-0001', 'active'], ['S002', 'P-0002', 'active'], ['S003', 'P-0003', 'active']])
    expect(list.subjects[0]!.age_at_enroll).toBe(64)
    expect(t.patients.accessLog(t.a, t.p1.id).map(l => l.action)).toEqual(expect.arrayContaining(['enroll', 'unenroll']))
  })

  it('只能入组诊疗组里的患者：同事（不在诊疗组）、机构全员可见、紧急访问、别的机构都不行', () => {
    const t = env()
    const nurseStudy = t.studies.create(t.u.nurseA, { title: '护士的研究' })
    expect(t.cohort.enroll(t.as(t.u.nurseA), nurseStudy.id, { patient_ids: [t.p1.id] }).skipped).toEqual([{ patient_id: t.p1.id, reason: '患者不存在' }])
    t.tenants.update(t.u.adminA, { settings: { patient_visibility: 'tenant' } })
    expect(t.cohort.enroll(t.as(t.u.nurseA), nurseStudy.id, { patient_ids: [t.p1.id] }).skipped[0]!.reason).toContain('不在诊疗组')
    t.tenants.update(t.u.adminA, { settings: { patient_visibility: 'care_team' } })
    t.patients.breakGlass(t.as(t.u.adminA), t.p1.id, '急诊需要查看既往化验结果以便处理')
    const adminStudy = t.studies.create(t.u.adminA, { title: '管理员的研究' })
    expect(t.cohort.enroll(t.as(t.u.adminA), adminStudy.id, { patient_ids: [t.p1.id] }).skipped[0]!.reason).toContain('不在诊疗组')
    const bStudy = t.studies.create(t.u.drB, { title: 'B 的研究' })
    expect(t.cohort.enroll(t.as(t.u.drB), bStudy.id, { patient_ids: [t.p1.id] }).skipped[0]!.reason).toBe('患者不存在')
    // 加进诊疗组后可以
    t.patients.addMember(t.a, t.p1.id, t.u.nurseA)
    expect(t.cohort.enroll(t.as(t.u.nurseA), nurseStudy.id, { patient_ids: [t.p1.id] }).enrolled).toHaveLength(1)
    // 机构关掉患者模块
    t.tenants.update(t.u.adminA, { settings: { patient_module: false } })
    expect(() => t.cohort.preview(t.a, t.study.id, {})).toThrow('没有启用患者模块')
  })

  it('AI 入组：机构设为需医生确认时变成提议，只有研究负责人能确认；direct 时直接生效', () => {
    const t = env()
    const ai = t.as(t.u.drA, 'ai')
    const r = t.cohort.enroll(ai, t.study.id, { patient_ids: [t.p1.id, t.p2.id] })
    expect([r.enrolled, r.proposed]).toEqual([[], [t.p1.id, t.p2.id]])
    expect(t.cohort.enroll(ai, t.study.id, { patient_ids: [t.p1.id] }).skipped[0]!.reason).toContain('待确认')
    const pending = t.cohort.list(t.a, t.study.id).pending
    expect(pending.map(p => [p.code, p.kind])).toEqual([['P-0001', 'enroll'], ['P-0002', 'enroll']])
    // 诊疗组的同事不能替研究负责人确认
    t.patients.addMember(t.a, t.p1.id, t.u.nurseA)
    expect(() => t.patients.resolveProposal(t.as(t.u.nurseA), t.p1.id, pending[0]!.proposal_id, true)).toThrow('研究负责人')
    expect(() => t.patients.resolveProposal(ai, t.p1.id, pending[0]!.proposal_id, true)).toThrow('AI 不能')
    t.patients.resolveProposal(t.a, t.p1.id, pending[0]!.proposal_id, true)
    t.patients.resolveProposal(t.a, t.p2.id, pending[1]!.proposal_id, false)
    expect(t.cohort.list(t.a, t.study.id).subjects.map(s => s.subject_id)).toEqual(['S001'])
    // 移出也要确认
    expect(t.cohort.unenroll(ai, t.study.id, t.p1.id)).toEqual({ result: 'proposed' })
    expect(t.cohort.list(t.a, t.study.id).active).toBe(1)
    t.tenants.update(t.u.adminA, { settings: { ai_patient_writes: 'direct' } })
    expect(t.cohort.enroll(ai, t.study.id, { patient_ids: [t.p3.id] }).enrolled).toEqual([{ patient_id: t.p3.id, subject_id: 'S002' }])
    expect(t.patients.accessLog(t.a, t.p3.id).find(l => l.action === 'enroll')!.via).toBe('ai')
  })

  it('删除研究：入组关系、待确认的入组提议一起清掉', () => {
    const t = env()
    t.cohort.enroll(t.a, t.study.id, { patient_ids: [t.p1.id] })
    t.cohort.enroll(t.as(t.u.drA, 'ai'), t.study.id, { patient_ids: [t.p2.id] })
    t.studies.remove(t.u.drA, t.study.id)
    expect(t.patients.read(t.a, t.p1.id).studies).toEqual([])
    expect(t.patients.read(t.a, t.p2.id).pending_proposals).toEqual([])
  })
})

describe('研究数据集', () => {
  it('宽表：只有研究编号（没有代号）、标准单位、基线 / 最近；生成的列不被当成身份信息；自动归入研究', async () => {
    const t = env()
    t.cohort.enroll(t.a, t.study.id, { patient_ids: [t.p1.id, t.p2.id] })
    const r = await t.cohort.dataset(t.a, t.study.id, { shape: 'wide' })
    expect(r.dataset.status).toBe('ready')
    expect(r.dataset.name).toBe('CKD 队列 · 队列宽表 v1')
    const { header, rows } = t.datasets.preview(t.u.drA, r.dataset.id)
    expect(header.slice(0, 5)).toEqual(['subject_id', 'sex', 'age_at_enroll', 'tags', 'enrolled_on'])
    expect(header).toContain('creatinine_baseline_umol_L')
    const col = (name: string) => rows.map(row => row[header.indexOf(name)])
    expect(col('subject_id')).toEqual(['S001', 'S002'])
    expect(col('creatinine_baseline_umol_L')).toEqual(['98', '160'])
    expect(col('creatinine_latest_umol_L')).toEqual(['185.7', '90'])
    expect(col('creatinine_n')).toEqual(['2', '2'])
    const csv = readFileSync(t.datasets.readyCsv(t.u.drA, r.dataset.id).path, 'utf8')
    expect(csv).not.toMatch(/P-000\d/)
    expect(r.dataset.labels.creatinine_baseline_umol_L).toBe('肌酐 基线（µmol/L）')
    expect(t.studies.read(t.u.drA, t.study.id).datasets.map(d => d.dataset_id)).toEqual([r.dataset.id])
    expect(t.patients.accessLog(t.a, t.p1.id).map(l => l.action)).toContain('cohort_export')
  })

  it('长表；入组或化验变化后过期，刷新生成新版本（旧版本保留）；数据没变时沿用', async () => {
    const t = env()
    t.cohort.enroll(t.a, t.study.id, { patient_ids: [t.p1.id] })
    const v1 = await t.cohort.dataset(t.a, t.study.id, { shape: 'long', tests: ['肌酐'] })
    expect(t.datasets.preview(t.u.drA, v1.dataset.id).rows.map(r => r.slice(0, 5))).toEqual([['S001', 'creatinine', '肌酐', '98', 'µmol/L'], ['S001', 'creatinine', '肌酐', '185.7', 'µmol/L']])
    const stale = () => t.cohort.list(t.a, t.study.id).datasets.map(d => [d.version, d.latest, d.stale])
    expect(stale()).toEqual([[1, true, false]])
    // 不相关的项目变化不影响（只取了肌酐）
    t.addReport(t.p1.id, '2025-09-01', [{ test_name: 'HbA1c', value: 7.5, unit: '%' }])
    expect(stale()).toEqual([[1, true, false]])
    t.addReport(t.p1.id, '2025-09-01', [{ test_name: '肌酐', value: 200, unit: 'µmol/L' }])
    expect(stale()).toEqual([[1, true, true]])
    const v2 = await t.cohort.dataset(t.a, t.study.id, { shape: 'long', tests: ['肌酐'] })
    expect([v2.dataset.version, v2.unchanged, v2.dataset.name]).toEqual([2, false, 'CKD 队列 · 队列长表 v2'])
    expect(stale()).toEqual([[2, true, false], [1, false, null]])
    // 入组变化
    t.cohort.enroll(t.a, t.study.id, { patient_ids: [t.p2.id] })
    expect(stale()[0]).toEqual([2, true, true])
    t.cohort.unenroll(t.a, t.study.id, t.p2.id)
    expect(stale()[0]).toEqual([2, true, false])
    const again = await t.cohort.dataset(t.a, t.study.id, { shape: 'long', tests: ['肌酐'] })
    expect([again.unchanged, again.dataset.id]).toEqual([true, v2.dataset.id])
  })

  it('解析失败时报错并删掉失败的数据集（不留空数据集、不归入研究）', async () => {
    const t = env()
    const broken = new DatasetService(t.store, mkdtempSync(join(tmpdir(), 'co-ds2-')), async () => { throw new Error('python 不在') })
    const cohort = new CohortService(t.studies, t.patients, broken)
    t.cohort.enroll(t.a, t.study.id, { patient_ids: [t.p1.id] })
    await expect(cohort.dataset(t.a, t.study.id, {})).rejects.toThrow('生成研究数据集失败：python 不在')
    expect(broken.list(t.u.drA)).toEqual([])
    expect(t.studies.read(t.u.drA, t.study.id).datasets).toEqual([])
  })

  it('没有入组的人不能生成；别人的研究不能生成；离开诊疗组的受试者不进数据集', async () => {
    const t = env()
    await expect(t.cohort.dataset(t.a, t.study.id, {})).rejects.toThrow('还没有入组')
    await expect(t.cohort.dataset(t.as(t.u.drB), t.study.id, {})).rejects.toThrow('研究不存在')
    // 护士入组了 P-0001（当时在诊疗组），之后被移出诊疗组
    t.patients.addMember(t.a, t.p1.id, t.u.nurseA)
    t.patients.addMember(t.a, t.p2.id, t.u.nurseA)
    const ns = t.studies.create(t.u.nurseA, { title: '护士的研究' })
    t.cohort.enroll(t.as(t.u.nurseA), ns.id, { patient_ids: [t.p1.id, t.p2.id] })
    t.patients.removeMember(t.a, t.p1.id, t.u.nurseA)
    const r = await t.cohort.dataset(t.as(t.u.nurseA), ns.id, { shape: 'wide' })
    expect(r.skipped).toEqual(['S001'])
    expect(t.datasets.preview(t.u.nurseA, r.dataset.id).rows.map(row => row[0])).toEqual(['S002'])
    // 名单里看不到已经无权查看的代号
    expect(t.cohort.list(t.as(t.u.nurseA), ns.id).subjects.map(s => [s.subject_id, s.code])).toEqual([['S001', null], ['S002', 'P-0002']])
  })
})

describe('研究入组：MCP（AI 与人相同）', () => {
  it('预览 → 入组（需确认时变成提议）→ 生成数据集 → dataset_open；机构不允许外部模型时 AI 打不开由患者生成的数据集', async () => {
    const t = env()
    const docs = new Documents(t.store)
    const claims = verifyToken('s', issueToken('s', { u: t.u.drA, d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 60 }), 'mcp')!
    const ws = mkdtempSync(join(tmpdir(), 'co-ws-'))
    const server = buildMcpServer({
      docs, ops: new OpService(docs), turns: new TurnRegistry(), secret: 's', claims: new ClaimService(docs, {} as PubMedClient), renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'co-r-'))),
      pubmed: {} as PubMedClient, crossref: {} as CrossrefClient, workspaceDir: () => ws, isLiveSession: () => true,
      datasets: t.datasets, patients: t.patients, studies: t.studies, cohort: t.cohort,
    }, claims)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'co', version: '0' })
    await client.connect(b)
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> }
      return { error: Boolean(r.isError), body: JSON.parse(r.content[0]!.text) }
    }
    const pv = await call('study_cohort_preview', { study_id: t.study.id, labs: [{ test: '肌酐', mode: 'any', op: '>', value: 133 }] })
    expect(pv.body.patients.map((p: { code: string }) => p.code)).toEqual(['P-0001', 'P-0002'])
    const en = await call('study_enroll', { study_id: t.study.id, patient_ids: [t.p1.id, t.p2.id] })
    expect(en.body.proposed).toHaveLength(2)
    expect((await call('study_cohort_list', { study_id: t.study.id })).body.pending).toHaveLength(2)
    t.tenants.update(t.u.adminA, { settings: { ai_patient_writes: 'direct' } })
    expect((await call('study_enroll', { study_id: t.study.id, patient_ids: [t.p1.id] })).body.enrolled).toEqual([{ patient_id: t.p1.id, subject_id: 'S001' }])
    const ds = await call('study_cohort_dataset', { study_id: t.study.id, shape: 'wide' })
    expect([ds.body.status, ds.body.rows, ds.body.version]).toEqual(['ready', 1, 1])
    const open = await call('dataset_open', { dataset_id: ds.body.dataset_id })
    expect(readFileSync(join(ws, open.body.path), 'utf8')).toContain('S001')
    expect((await call('study_unenroll', { study_id: t.study.id, patient_id: t.p1.id })).body).toEqual({ result: 'withdrawn' })
    expect((await call('study_cohort_list', { study_id: t.study.id })).body.datasets[0].stale).toBe(true)
    t.tenants.update(t.u.adminA, { settings: { external_model_for_patients: false } })
    const blocked = await call('dataset_open', { dataset_id: ds.body.dataset_id })
    expect([blocked.error, blocked.body.code]).toEqual([true, 'external_model_off'])
    expect((await call('dataset_describe', { dataset_id: ds.body.dataset_id })).body.code).toBe('external_model_off')
    // 人仍能在界面上用
    expect(t.datasets.preview(t.u.drA, ds.body.dataset_id).rows).toHaveLength(1)
  })
})
