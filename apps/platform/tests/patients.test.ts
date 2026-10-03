import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TenantService } from '../src/auth/tenants.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, KeyDestroyedError, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientError, PatientService, testKey, type Actor } from '../src/tenancy/patients.ts'
import { redact } from '../src/tenancy/extract-report.ts'

function env() {
  const store = new Store(':memory:')
  const tenants = new TenantService(store, { devMode: false })
  const keys = new TenantKeys(store, kekFrom({ secret: 'test-secret' }))
  const root = mkdtempSync(join(tmpdir(), 'hr-pt-'))
  const svc = new PatientService(root, tenants, keys, store)
  const hospA = store.createTenant({ name: '医院 A', kind: 'org' })
  const hospB = store.createTenant({ name: '医院 B', kind: 'org' })
  const user = (name: string, tenant: string, role: 'admin' | 'member' = 'member') => store.createUser({ username: name, display_name: name, password_hash: 'x', tenant: { id: tenant, role } }).id
  const u = { drA: user('drA', hospA.id), nurseA: user('nurseA', hospA.id), adminA: user('adminA', hospA.id, 'admin'), drB: user('drB', hospB.id) }
  const as = (userId: string, via: Actor['via'] = 'user'): Actor => ({ userId, via })
  return { store, tenants, keys, root, svc, hospA, hospB, u, as }
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
    expect(csv.csv.split('\n')[1]).toBe('P-0001,creatinine,Cr,98,,µmol/L,57,111,,2025-03-02')
  })
})

describe('患者：AI 只能提议', () => {
  it('AI 不能新建、修改、直接写化验；提议要写依据；人采纳后生效并标明来源', () => {
    const t = env()
    const p = t.svc.create(t.as(t.u.drA), {})
    const ai = t.as(t.u.drA, 'ai')
    expect(() => t.svc.create(ai, {})).toThrow('AI')
    expect(() => t.svc.update(ai, p.id, { tags: [] })).toThrow('提议')
    expect(() => t.svc.addLab(ai, p.id, { test_name: 'ALT', value: 50, collected_on: '2025-01-01' })).toThrow('提议')
    expect(() => t.svc.propose(ai, p.id, { kind: 'lab', payload: { test_name: 'ALT', value: 50, collected_on: '2025-01-01' } })).toThrow('依据')
    const prop = t.svc.propose(ai, p.id, { kind: 'lab', payload: { test_name: 'ALT', value: 50, unit: 'U/L', ref_high: 40, collected_on: '2025-01-01' }, reason: '2025-01-01 肝功能报告第 1 页' })
    expect(t.svc.labs(t.as(t.u.drA), p.id)).toEqual([])
    expect(() => t.svc.resolveProposal(ai, p.id, prop.id, true)).toThrow('AI')
    t.svc.resolveProposal(t.as(t.u.drA), p.id, prop.id, true)
    expect(t.svc.labs(t.as(t.u.drA), p.id).map(l => [l.test_key, l.flag, l.source])).toEqual([['alt', 'H', 'ai']])
    const tag = t.svc.propose(ai, p.id, { kind: 'tag', payload: { tag: '脂肪肝' }, reason: '出院小结诊断' })
    t.svc.resolveProposal(t.as(t.u.drA), p.id, tag.id, false)
    expect(t.svc.read(t.as(t.u.drA), p.id).tags).toEqual([])
    expect(t.svc.accessLog(t.as(t.u.drA), p.id).filter(l => l.via === 'ai').map(l => l.action)).toContain('propose')
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

  it('机构关闭「交给外部模型」：不提取、不发给模型，改手工录入', async () => {
    const t = withExtractor(good)
    t.tenants.update(t.u.adminA, { settings: { external_model_for_patients: false } })
    const a = t.as(t.u.drA)
    const p = t.svc.create(a, {})
    const up = t.svc.addFile(a, p.id, { name: 'x.pdf', mime: 'application/pdf', bytes: Buffer.from('pdf') })
    await t.svc.idle()
    expect([up.record.extraction, up.record.extraction_note]).toEqual(['skipped', '本机构设置为患者数据不交给外部模型，请手工录入'])
    expect(t.sent).toEqual([])
  })
})
