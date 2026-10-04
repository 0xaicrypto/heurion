import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TenantService } from '../src/auth/tenants.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, KeyDestroyedError, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientError, PatientService, testKey, type Actor } from '../src/tenancy/patients.ts'
import { extractReport, redact } from '../src/tenancy/extract-report.ts'
import { normUnit, standardize } from '../src/tenancy/units.ts'

function env() {
  const store = new Store(':memory:')
  const tenants = new TenantService(store, { devMode: false })
  const keys = new TenantKeys(store, kekFrom({ secret: 'test-secret' }))
  const root = mkdtempSync(join(tmpdir(), 'hr-pt-'))
  const svc = new PatientService(root, tenants, keys, store)
  const hospA = store.createTenant({ name: '医院 A', kind: 'org' })
  const hospB = store.createTenant({ name: '医院 B', kind: 'org' })
  const personal = store.createTenant({ name: 'mom 的个人空间', kind: 'personal' })
  const user = (name: string, tenant: string, role: 'admin' | 'member' = 'member') => store.createUser({ username: name, display_name: name, password_hash: 'x', tenant: { id: tenant, role } }).id
  const u = { pm: user('pm', personal.id), drA: user('drA', hospA.id), nurseA: user('nurseA', hospA.id), adminA: user('adminA', hospA.id, 'admin'), drB: user('drB', hospB.id) }
  const as = (userId: string, via: Actor['via'] = 'user'): Actor => ({ userId, via })
  return { store, tenants, keys, root, svc, hospA, hospB, personal, u, as }
}

describe('患者：机构隔离与可见范围', () => {
  it('每个机构一个库文件、各自编号；别的机构拿着 id 也读不到', () => {
    const t = env()
    const pa = t.svc.create(t.as(t.u.drA), { sex: 'M', birth_year: 1962, tags: ['2型糖尿病', 'CKD3'] })
    const pb = t.svc.create(t.as(t.u.drB), { sex: '女' })
    expect([pa.code, pb.code, pb.sex]).toEqual(['P-0001', 'P-0001', 'F'])
    expect(readdirSync(t.root).sort()).toEqual([t.hospA.id, t.hospB.id].sort())
    expect(() => t.svc.read(t.as(t.u.drB), pa.id)).toThrow('患者不存在')
    expect(t.svc.list(t.as(t.u.drB)).map(p => p.id)).toEqual([pb.id])
  })

  it('称呼：只在知家（个人空间）可用——个人空间写入（加密存储）、可改可清空；医院端传称呼拒绝', () => {
    const t = env()
    const a = t.as(t.u.pm)
    const p = t.svc.create(a, { name: '妈妈', sex: 'F', birth_year: 1990, tags: ['孕产'] })
    expect(p.name).toBe('妈妈')
    expect(t.svc.list(a).map(x => x.name)).toEqual(['妈妈'])
    // 库文件里看不到明文称呼
    const raw = readFileSync(join(t.root, t.personal.id, 'patients.db'))
    expect(raw.includes(Buffer.from('妈妈'))).toBe(false)
    // 改称呼 / 清空
    t.svc.update(a, p.id, { name: '老妈' })
    expect(t.svc.read(a, p.id).name).toBe('老妈')
    t.svc.update(a, p.id, { name: '' })
    expect(t.svc.read(a, p.id).name).toBeNull()
    // 医院端：传称呼直接拒绝（真名不落库、也不会发给外部模型）；不传的患者仍是 null
    expect(() => t.svc.create(t.as(t.u.drA), { name: '张三', sex: 'M' })).toThrow('医院端患者只用代号')
    const q = t.svc.create(t.as(t.u.drA), { sex: 'M' })
    expect(q.name).toBeNull()
  })

  it('成员建档即建「健康档案」文档（知家）：个人空间建患者钩子收到 owner / 称呼标题 / 归属；医院端不触发；钩子缺席时建档不受影响', () => {
    const t = env()
    const calls: Array<{ owner: string; title: string; patientId: string }> = []
    const svc2 = new PatientService(t.root, t.tenants, t.keys, t.store, null, input => { calls.push(input); return null })
    const p = svc2.create(t.as(t.u.pm), { name: '宝宝', birth_year: 2023 })
    expect(calls).toEqual([{ owner: t.u.pm, title: '宝宝 的健康档案', patientId: p.id }])
    // 医院端建患者不生成健康档案（临床文书不受患者红线约束）
    svc2.create(t.as(t.u.drA), { sex: 'M' })
    expect(calls).toHaveLength(1)
    // 没有 hooks 的原路径照常
    const q = t.svc.create(t.as(t.u.pm), { name: '妈妈' })
    expect(q.name).toBe('妈妈')
  })

  it('诊疗组：同机构的人默认看不到，加进诊疗组后能看能改；机构设置「全员可见」时只能看不能改', () => {
    const t = env()
    const p = t.svc.create(t.as(t.u.drA), {})
    expect(() => t.svc.read(t.as(t.u.nurseA), p.id)).toThrow(PatientError)
    expect(t.svc.list(t.as(t.u.nurseA))).toEqual([])
    t.svc.addMember(t.as(t.u.drA), p.id, t.u.nurseA)
    expect(t.svc.read(t.as(t.u.nurseA), p.id).access).toBe('member')
    t.svc.update(t.as(t.u.nurseA), p.id, { tags: ['心衰'] })
    expect(() => t.svc.addMember(t.as(t.u.nurseA), p.id, t.u.adminA)).toThrow('只有负责人')
    expect(() => t.svc.addMember(t.as(t.u.drA), p.id, t.u.drB)).toThrow('本机构没有这位成员')

    t.tenants.update(t.u.adminA, { settings: { patient_visibility: 'tenant' } })
    expect(t.svc.read(t.as(t.u.adminA), p.id).access).toBe('tenant')
    expect(() => t.svc.update(t.as(t.u.adminA), p.id, { tags: [] })).toThrow('诊疗组成员')
  })

  it('紧急访问：只有机构管理员、必须写理由、24 小时只读、留访问日志与审计', () => {
    const t = env()
    const p = t.svc.create(t.as(t.u.drA), {})
    expect(t.svc.directory(t.as(t.u.adminA))).toEqual([{ id: p.id, code: 'P-0001' }])
    expect(() => t.svc.directory(t.as(t.u.nurseA))).toThrow('机构管理员')
    expect(() => t.svc.read(t.as(t.u.adminA), p.id)).toThrow('患者不存在')
    expect(() => t.svc.breakGlass(t.as(t.u.nurseA), p.id, '患者急诊需要查看既往化验结果')).toThrow('机构管理员')
    expect(() => t.svc.breakGlass(t.as(t.u.adminA), p.id, '看看')).toThrow('理由')
    const bg = t.svc.breakGlass(t.as(t.u.adminA), p.id, '患者夜间急诊，主治不在，需要查看既往肾功能')
    expect(Date.parse(bg.expires_at) - Date.now()).toBeGreaterThan(23 * 3600_000)
    expect(t.svc.read(t.as(t.u.adminA), p.id).access).toBe('break_glass')
    expect(() => t.svc.update(t.as(t.u.adminA), p.id, { tags: [] })).toThrow('诊疗组成员')
    expect(t.svc.accessLog(t.as(t.u.drA), p.id).map(l => l.action)).toEqual(expect.arrayContaining(['break_glass', 'view', 'create']))
    expect(t.store.listAudit({ tenant: t.hospA.id }).map(r => r.action)).toContain('patient.break_glass')
  })
})

describe('患者：化验', () => {
  it('同一项目不同叫法归一；按参考范围标高低；只返回已确认的；导出的长表只有代号', () => {
    const t = env()
    const a = t.as(t.u.drA)
    const p = t.svc.create(a, {})
    expect([testKey('谷丙转氨酶'), testKey('ALT'), testKey('血肌酐'), testKey('HbA1c')]).toEqual(['alt', 'alt', 'creatinine', 'hba1c'])
    expect([testKey('丙氨酸氨基转移酶(ALT)'), testKey('肌酐（Cr）'), testKey('估算肾小球滤过率(eGFR)'), testKey('某新项目(XYZ)')]).toEqual(['alt', 'creatinine', 'egfr', '某新项目'])
    t.svc.addLab(a, p.id, { test_name: '血肌酐', value: '126', unit: 'µmol/L', ref_low: 57, ref_high: 111, collected_on: '2025-06-10' })
    t.svc.addLab(a, p.id, { test_name: 'Cr', value: 98, unit: 'µmol/L', ref_low: 57, ref_high: 111, collected_on: '2025-03-02' })
    t.svc.addLab(a, p.id, { test_name: '血红蛋白', value: 98, unit: 'g/L', ref_low: 130, ref_high: 175, collected_on: '2025-06-10' }, { status: 'pending', source: 'extracted' })
    expect(() => t.svc.addLab(a, p.id, { test_name: '肌酐', value: 1, collected_on: '2025/06/10' })).toThrow('YYYY-MM-DD')

    const labs = t.svc.labs(a, p.id)
    expect(labs.map(l => [l.test_key, l.value_num, l.flag, l.collected_on])).toEqual([['creatinine', 98, null, '2025-03-02'], ['creatinine', 126, 'H', '2025-06-10']])
    const pending = t.svc.labs(a, p.id, { includePending: true }).find(l => l.status === 'pending')!
    expect(pending.flag).toBe('L')
    t.svc.setLabStatus(a, p.id, pending.id, 'confirmed')
    expect(t.svc.read(a, p.id).latest_labs.map(l => l.test_key)).toEqual(['creatinine', 'hemoglobin'])
    const csv = t.svc.labsCsv(a, p.id)
    expect(csv.csv.split('\n')[0]).toBe('patient,test_key,test_name,value,unit,ref_low,ref_high,flag,collected_on,collected_at,orig_value,orig_unit,value_text')
    expect(csv.csv.split('\n')[1]).toBe('P-0001,creatinine,Cr,98,µmol/L,57,111,,2025-03-02,,98,µmol/L,')
  })
})

describe('患者：AI 与人操作能力相同', () => {
  it('默认（需医生确认）：AI 能新建、改信息、上传报告、补项、改待确认的项、关联文档，但写入都进待确认；确认 / 驳回只能由人做', () => {
    const t = env()
    const ai = t.as(t.u.drA, 'ai')
    const dr = t.as(t.u.drA)
    const p = t.svc.create(ai, { sex: 'M', tags: ['CKD3'] })
    expect(t.svc.read(dr, p.id).care_team.map(m => m.role)).toEqual(['owner'])

    // 改信息 → 一条「修改」提议，人采纳后生效
    t.svc.update(ai, p.id, { tags: ['CKD3', '2型糖尿病'] })
    expect(t.svc.read(dr, p.id).tags).toEqual(['CKD3'])
    const prop = t.svc.read(dr, p.id).pending_proposals[0]!
    expect(prop.kind).toBe('update')
    expect(() => t.svc.resolveProposal(ai, p.id, prop.id, true)).toThrow('AI')
    t.svc.resolveProposal(dr, p.id, prop.id, true)
    expect(t.svc.read(dr, p.id).tags).toEqual(['CKD3', '2型糖尿病'])

    // 上传报告、补项、改项：都在待确认里
    const up = t.svc.addFile(ai, p.id, { name: 'r.pdf', mime: 'application/pdf', bytes: Buffer.from('x'), report_date: '2025-09-01' })
    const lab = t.svc.addRecordLab(ai, p.id, up.record.id, { test_name: 'ALT', value: 50, unit: 'U/L', ref_high: 40 })
    expect([lab.status, lab.source, lab.flag]).toEqual(['pending', 'ai', 'H'])
    t.svc.editLab(ai, p.id, lab.id, { value: 52 })
    expect(() => t.svc.resolveRecord(ai, p.id, up.record.id, { accept: true })).toThrow('医生')
    expect(() => t.svc.setLabStatus(ai, p.id, lab.id, 'confirmed')).toThrow('医生')
    expect(() => t.svc.addLab(ai, p.id, { test_name: 'ALT', value: 50, collected_on: '2025-01-01' })).toThrow('上传的报告')
    t.svc.resolveRecord(dr, p.id, up.record.id, { accept: true })
    expect(t.svc.labs(dr, p.id).map(l => [l.test_key, l.value_num, l.source])).toEqual([['alt', 52, 'ai']])

    // 关联文档（AI 写的病例报告）
    const doc = t.store.createDoc({ owner: t.u.drA, title: 'P-0001 病例报告', kind: 'doc', state: new Uint8Array() })
    t.svc.linkDoc(ai, p.id, doc.id)
    expect(t.svc.read(dr, p.id).documents.map(d => d.title)).toEqual(['P-0001 病例报告'])
    // 属于患者的文档不在文档列表里
    expect(t.store.listDocs(t.u.drA).map(d => d.id)).not.toContain(doc.id)
    expect(JSON.parse(t.store.getDoc(doc.id)!.context!)).toMatchObject({ kind: 'patient', patient_id: p.id, code: 'P-0001' })
    t.svc.unlinkDoc(dr, p.id, doc.id)
    expect(t.store.listDocs(t.u.drA).map(d => d.id)).toContain(doc.id)
    t.svc.linkDoc(dr, p.id, doc.id)

    // 不给 AI：删除、紧急访问
    expect(() => t.svc.remove(ai, p.id)).toThrow('删除')
    expect(() => t.svc.breakGlass(t.as(t.u.adminA, 'ai'), p.id, '患者夜间急诊需要查看既往化验')).toThrow('AI')
    expect(t.svc.accessLog(dr, p.id).filter(l => l.via === 'ai').map(l => l.action)).toEqual(expect.arrayContaining(['create', 'propose', 'file_upload', 'lab_add', 'lab_edit', 'doc_link']))
  })

  it('机构设为「直接生效」：AI 的修改和确认和人一样直接生效', () => {
    const t = env()
    t.tenants.update(t.u.adminA, { settings: { ai_patient_writes: 'direct' } })
    const ai = t.as(t.u.drA, 'ai')
    const p = t.svc.create(ai, {})
    t.svc.update(ai, p.id, { tags: ['心衰'] })
    expect(t.svc.read(t.as(t.u.drA), p.id).tags).toEqual(['心衰'])
    const up = t.svc.addFile(ai, p.id, { name: 'r.pdf', mime: 'application/pdf', bytes: Buffer.from('x'), report_date: '2025-09-01' })
    t.svc.addRecordLab(ai, p.id, up.record.id, { test_name: 'NT-proBNP', value: 1850, unit: 'pg/mL', ref_high: 125 })
    t.svc.resolveRecord(ai, p.id, up.record.id, { accept: true })
    expect(t.svc.labs(t.as(t.u.drA), p.id).map(l => [l.test_key, l.status, l.flag])).toEqual([['nt_probnp', 'confirmed', 'H']])
  })

  it('AI 的提议要写依据；人不采纳就不生效', () => {
    const t = env()
    const p = t.svc.create(t.as(t.u.drA), {})
    const ai = t.as(t.u.drA, 'ai')
    expect(() => t.svc.propose(ai, p.id, { kind: 'tag', payload: { tag: '脂肪肝' } })).toThrow('依据')
    const tag = t.svc.propose(ai, p.id, { kind: 'tag', payload: { tag: '脂肪肝' }, reason: '出院小结诊断' })
    t.svc.resolveProposal(t.as(t.u.drA), p.id, tag.id, false)
    expect(t.svc.read(t.as(t.u.drA), p.id).tags).toEqual([])
  })

  it('机构关闭「患者数据交给外部模型」时 AI 一律不能访问；关闭患者模块时谁都不能访问', () => {
    const t = env()
    const p = t.svc.create(t.as(t.u.drA), {})
    t.tenants.update(t.u.adminA, { settings: { external_model_for_patients: false } })
    expect(() => t.svc.read(t.as(t.u.drA, 'ai'), p.id)).toThrow('外部模型')
    expect(t.svc.read(t.as(t.u.drA), p.id).id).toBe(p.id)
    t.tenants.update(t.u.adminA, { settings: { patient_module: false } })
    expect(() => t.svc.list(t.as(t.u.drA))).toThrow('没有启用患者模块')
  })
})

describe('患者：加密', () => {
  it('原始文件与文件名加密存盘；删除患者连文件删；销毁机构密钥后无法解密', () => {
    const t = env()
    const a = t.as(t.u.drA)
    const p = t.svc.create(a, {})
    const secret = '姓名：张三 住院号 20250312 肌酐 141'
    const up = t.svc.addFile(a, p.id, { name: '张三-化验单.pdf', mime: 'application/pdf', bytes: Buffer.from(secret), kind: 'lab_report', report_date: '2025-09-01', title: '肾功能' })
    expect(up.record).toMatchObject({ status: 'pending', report_date: '2025-09-01', kind: 'lab_report' })
    const onDisk = readFileSync(join(t.root, t.hospA.id, 'files', up.file_id))
    expect(onDisk.toString('utf8')).not.toContain('肌酐')
    expect(readFileSync(join(t.root, t.hospA.id, 'patients.db')).toString('utf8')).not.toContain('张三')
    expect(t.svc.file(a, p.id, up.file_id)).toMatchObject({ name: '张三-化验单.pdf', bytes: Buffer.from(secret) })
    expect(() => t.svc.file(t.as(t.u.drB), p.id, up.file_id)).toThrow('患者不存在')

    t.keys.destroy(t.hospA.id)
    expect(() => t.svc.file(a, p.id, up.file_id)).toThrow(KeyDestroyedError)

    const t2 = env()
    const p2 = t2.svc.create(t2.as(t2.u.drA), {})
    const f2 = t2.svc.addFile(t2.as(t2.u.drA), p2.id, { name: 'x.pdf', mime: 'application/pdf', bytes: Buffer.from('x') })
    t2.svc.remove(t2.as(t2.u.drA), p2.id)
    expect(existsSync(join(t2.root, t2.hospA.id, 'files', f2.file_id))).toBe(false)
    expect(t2.svc.list(t2.as(t2.u.drA))).toEqual([])
  })
})

describe('患者：报告自动提取', () => {
  it('打码：姓名字段里的名字在全文任何位置都换掉；证件号、电话、住院号、床号、出生日期；化验数值不动', () => {
    const text = '姓 名：李建国  床 号：12  住院号：0098231  出生日期：1962-03-05  电话 13812345678  身份证 340102196203051234\n肌酐 168 µmol/L\n审核：陈某  李建国 签名'
    const out = redact(text)
    expect(out).not.toMatch(/李建国|0098231|1962-03-05|13812345678|340102196203051234|床 号：12/)
    expect(out).toContain('肌酐 168 µmol/L')
  })

  const REPORT = `某某医院检验报告单
姓名：张三   性别：男   年龄：62岁   住院号：ZY20250312   联系电话：13812345678
采样时间：2025-09-01 08:12
项目            结果      单位      参考范围
谷丙转氨酶      52↑       U/L       9-50
血肌酐          141       µmol/L    57-111
血红蛋白        128       g/L       130-175`

  function withExtractor(reply: (input: string) => unknown) {
    const t = env()
    const sent: string[] = []
    const svc = new PatientService(t.root, t.tenants, t.keys, t.store, {
      pages: async () => [REPORT],
      complete: async (_system, user) => { sent.push(user); return JSON.stringify(reply(user)) },
    })
    return { ...t, svc, sent }
  }
  const good = () => ({ kind: 'lab_report', title: '肝肾功能 张三', report_date: '2025-09-01', labs: [
    { test_name: '谷丙转氨酶', value: '52↑', unit: 'U/L', ref_low: 9, ref_high: 50, page: 1 },
    { test_name: '血肌酐', value: '141', unit: 'µmol/L', ref_low: 57, ref_high: 111, page: 1 },
    { test_name: '血红蛋白', value: '128', unit: 'g/L', ref_low: 130, ref_high: 175, page: 1 },
    { test_name: '尿酸', value: '612', unit: 'µmol/L', ref_low: 208, ref_high: 428, page: 1 }, // 报告里没有：模型编的
  ] })

  it('发给模型前打码；提取结果进待确认、带页码；原文里找不到的数标出来；确认报告后生效', async () => {
    const t = withExtractor(good)
    const a = t.as(t.u.drA)
    const p = t.svc.create(a, {})
    const up = t.svc.addFile(a, p.id, { name: '张三化验.pdf', mime: 'application/pdf', bytes: Buffer.from('pdf') })
    expect(up.record.extraction).toBe('queued')
    await t.svc.idle()
    expect(t.sent[0]).not.toMatch(/张三|13812345678|ZY20250312/)
    expect(t.sent[0]).toContain('谷丙转氨酶')

    const rec = t.svc.read(a, p.id).records[0]!
    expect(rec).toMatchObject({ kind: 'lab_report', title: '肝肾功能 【姓名】', report_date: '2025-09-01', extraction: 'done' })
    expect(rec.extraction_note).toContain('1 项在原文里没找到')
    expect(t.svc.labs(a, p.id)).toEqual([])
    const pending = t.svc.labs(a, p.id, { includePending: true })
    expect(pending.map(l => [l.test_key, l.value_num, l.flag, l.locator?.verified])).toEqual([
      ['alt', 52, 'H', true], ['creatinine', 141, 'H', true], ['hemoglobin', 128, 'L', true], ['uric_acid', 612, 'H', false],
    ])
    // 医生驳回编造的那条、改一条，再确认整份报告
    t.svc.setLabStatus(a, p.id, pending.find(l => l.test_key === 'uric_acid')!.id, 'rejected')
    t.svc.editLab(a, p.id, pending.find(l => l.test_key === 'hemoglobin')!.id, { value: 131 })
    t.svc.resolveRecord(a, p.id, rec.id, { accept: true })
    expect(t.svc.labs(a, p.id).map(l => [l.test_key, l.value_num, l.flag, l.collected_on])).toEqual([
      ['alt', 52, 'H', '2025-09-01'], ['creatinine', 141, 'H', '2025-09-01'], ['hemoglobin', 131, null, '2025-09-01'],
    ])
  })

  it('原文核对：数值按列排（PDF 文字层常见）也能核对到；38 不会误配 38.6；带箭头的值先去掉箭头', async () => {
    const columnar = '项目名称\n丙氨酸氨基转移酶(ALT)\n白蛋白(ALB)\n结果\n35\n38.6\n提示\n↓\n单位\nU/L\ng/L'
    const r = await extractReport([columnar], async () => JSON.stringify({ kind: 'lab_report', title: '肝功能', report_date: '2025-03-02', labs: [
      { test_name: 'ALT', value: '35', page: 1 }, { test_name: '白蛋白', value: '38.6↓', page: 1 }, { test_name: '白蛋白（编的）', value: '38', page: 1 },
    ] }))
    expect(r.labs.map(l => l.verified)).toEqual([true, true, false])
  })

  it('报告上没有日期：化验先不带日期，确认报告时必须补填（不用上传时间代替）', async () => {
    const t = withExtractor(() => ({ ...good(), report_date: null, labs: good().labs.slice(1, 2) }))
    const a = t.as(t.u.drA)
    const p = t.svc.create(a, {})
    t.svc.addFile(a, p.id, { name: 'x.pdf', mime: 'application/pdf', bytes: Buffer.from('pdf') })
    await t.svc.idle()
    const rec = t.svc.read(a, p.id).records[0]!
    expect(rec.extraction_note).toContain('没找到日期')
    const lab = t.svc.labs(a, p.id, { includePending: true })[0]!
    expect(lab.collected_on).toBeNull()
    expect(() => t.svc.setLabStatus(a, p.id, lab.id, 'confirmed')).toThrow('日期')
    expect(() => t.svc.resolveRecord(a, p.id, rec.id, { accept: true })).toThrow('日期')
    t.svc.resolveRecord(a, p.id, rec.id, { accept: true, report_date: '2025-08-30' })
    expect(t.svc.labs(a, p.id)[0]!.collected_on).toBe('2025-08-30')
  })

  it('机构关闭「交给外部模型」：不提取、不发给模型，在审核里对照原件补项', async () => {
    const t = withExtractor(good)
    t.tenants.update(t.u.adminA, { settings: { external_model_for_patients: false } })
    const a = t.as(t.u.drA)
    const p = t.svc.create(a, {})
    const up = t.svc.addFile(a, p.id, { name: 'x.pdf', mime: 'application/pdf', bytes: Buffer.from('pdf') })
    await t.svc.idle()
    expect(up.record.extraction).toBe('skipped')
    expect(up.record.extraction_note).toContain('不交给外部模型')
    // 不能自动提取时：审核里对照原件补项（挂在这份报告上、待确认）
    const lab = t.svc.addRecordLab(a, p.id, up.record.id, { test_name: '肌酐(Cr)', value: '168', unit: 'µmol/L', ref_low: 57, ref_high: 111 })
    expect([lab.record_id, lab.status, lab.test_key, lab.flag]).toEqual([up.record.id, 'pending', 'creatinine', 'H'])
    expect(t.sent).toEqual([])
  })
})

describe('患者：多次化验单', () => {
  const up = (t: ReturnType<typeof env>, pid: string, name: string, date: string, time?: string) =>
    t.svc.addFile(t.as(t.u.drA), pid, { name, mime: 'application/pdf', bytes: Buffer.from(name + date + (time ?? '')), report_date: date })

  it('单位换算：mg/dL 的肌酐、mmol/mol 的 HbA1c 换到标准单位；不认识的单位标出来；写法归一', () => {
    expect(standardize('creatinine', 1.6, 'mg/dl')).toEqual({ value: 141.5, unit: 'µmol/L', converted: true, unknown_unit: false })
    expect(standardize('hba1c', 64, 'mmol/mol')).toMatchObject({ value: 8.006, unit: '%', converted: true })
    expect(standardize('glucose', 126, 'mg/dL').value).toBeCloseTo(6.99, 2)
    expect(standardize('creatinine', 141, 'umol/L')).toMatchObject({ value: 141, unit: 'µmol/L', converted: false })
    expect(standardize('creatinine', 1.6, 'mmol/L')).toMatchObject({ unknown_unit: true })
    expect([normUnit('μmol/l'), normUnit('10^9/l'), normUnit('mL/min/1.73m2')]).toEqual(['µmol/L', '10^9/L', 'mL/min/1.73m²'])
  })

  it('同一份报告重复上传被拦下，并说明是哪次传过的', () => {
    const t = env()
    const p = t.svc.create(t.as(t.u.drA), {})
    up(t, p.id, '肝肾功能.pdf', '2025-06-10')
    expect(() => up(t, p.id, '肝肾功能.pdf', '2025-06-10')).toThrow('已经上传过')
  })

  it('不同医院不同单位：换算后可比（原值保留）', () => {
    const t = env()
    const dr = t.as(t.u.drA)
    const p = t.svc.create(dr, {})
    const r1 = up(t, p.id, 'A 医院.pdf', '2025-03-02')
    t.svc.addRecordLab(dr, p.id, r1.record.id, { test_name: '肌酐', value: 112, unit: 'µmol/L', ref_low: 57, ref_high: 111 })
    t.svc.resolveRecord(dr, p.id, r1.record.id, { accept: true })
    const r2 = up(t, p.id, 'B 医院.pdf', '2025-06-10')
    t.svc.addRecordLab(dr, p.id, r2.record.id, { test_name: 'Creatinine', value: 1.9, unit: 'mg/dL', ref_low: 0.7, ref_high: 1.3 })
    t.svc.resolveRecord(dr, p.id, r2.record.id, { accept: true })
    const labs = t.svc.labs(dr, p.id)
    expect(labs.map(l => [l.std_value, l.std_unit, l.converted, l.flag])).toEqual([[112, 'µmol/L', false, 'H'], [168, 'µmol/L', true, 'H']])
    expect(labs[1]).toMatchObject({ value_num: 1.9, unit: 'mg/dL', std_ref_low: 61.9, std_ref_high: 115 })
  })

  it('同一天：更正报告选「替换」后旧值标为已被更正；完全相同的重复值自动去掉；不同的值都保留', () => {
    const t = env()
    const dr = t.as(t.u.drA)
    const p = t.svc.create(dr, {})
    const r1 = up(t, p.id, '首份.pdf', '2025-06-10')
    t.svc.addRecordLab(dr, p.id, r1.record.id, { test_name: '肌酐', value: 186, unit: 'µmol/L' })
    t.svc.addRecordLab(dr, p.id, r1.record.id, { test_name: '钾', value: 5.3, unit: 'mmol/L' })
    t.svc.resolveRecord(dr, p.id, r1.record.id, { accept: true })
    const [creat] = t.svc.labs(dr, p.id, { tests: ['肌酐'] })

    // 同日更正报告：肌酐 168（更正）、钾 5.3（与已确认相同）、尿酸（新项）
    const r2 = up(t, p.id, '更正.pdf', '2025-06-10')
    const fix = t.svc.addRecordLab(dr, p.id, r2.record.id, { test_name: '肌酐(Cr)', value: 168, unit: 'µmol/L' })
    t.svc.addRecordLab(dr, p.id, r2.record.id, { test_name: 'K', value: 5.3, unit: 'mmol/L' })
    t.svc.addRecordLab(dr, p.id, r2.record.id, { test_name: '尿酸', value: 498, unit: 'µmol/L' })
    const pending = t.svc.labs(dr, p.id, { includePending: true }).filter(l => l.status === 'pending')
    expect(pending.find(l => l.id === fix.id)!.same_day!.map(o => o.std_value)).toEqual([186])
    expect(() => t.svc.editLab(dr, p.id, fix.id, { replaces: 'lbnope' })).toThrow('同一天')
    t.svc.editLab(dr, p.id, fix.id, { replaces: creat!.id })
    t.svc.resolveRecord(dr, p.id, r2.record.id, { accept: true })
    expect(t.svc.labs(dr, p.id).map(l => [l.test_key, l.std_value])).toEqual([['creatinine', 168], ['potassium', 5.3], ['uric_acid', 498]])
    expect(t.svc.read(dr, p.id).latest_labs.find(l => l.test_key === 'creatinine')!.std_value).toBe(168)

    // 同日另一份、不同的值，没选替换：两个都保留
    const r3 = up(t, p.id, '下午复查.pdf', '2025-06-10')
    t.svc.addRecordLab(dr, p.id, r3.record.id, { test_name: '钾', value: 4.9, unit: 'mmol/L' })
    t.svc.resolveRecord(dr, p.id, r3.record.id, { accept: true })
    expect(t.svc.labs(dr, p.id, { tests: ['钾'] }).map(l => l.std_value)).toEqual([5.3, 4.9])
  })
})
