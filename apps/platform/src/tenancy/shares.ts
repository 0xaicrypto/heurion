import type { TenantService } from '../auth/tenants.ts'
import type { Documents } from '../model/runtime.ts'
import type { PhrShareRow, Store } from '../store/db.ts'
import { PatientError, type Actor, type PatientService, type ShareScope } from './patients.ts'

/**
 * 知家「分享给医生」（docs/design/SHARING.md）：
 * - 家人（知家，个人空间）把一位成员的档案分享给某医院的某科室，可再指定一位医生；范围（类目、起始日期）、有效期（7 / 30 / 90 天）、
 *   是否允许纳入本院、可选「给医生看的姓名」都由家人定。撤销立即生效，到期自动失效。
 * - 医生侧只读实时视图：数据不复制，每次按分享去读家人个人空间里的库；每次查看 / 下载都记到家人那边该成员的访问日志。
 * - 家人允许时，医生可一键纳入本院（复制成本院患者，来源追溯到分享 id；纳入后归医院，撤销不影响已纳入部分）。
 * - 医生的 AI 与医生本人一致（MCP share_*），只受本院「患者数据不发外部模型」约束；不给 AI「给医生看的姓名」。
 * - 看不到的分享一律当不存在（404）。
 */

const CATEGORIES = ['labs', 'reports', 'docs'] as const
const DAYS = [7, 30, 90]
const DATE = /^\d{4}-\d{2}-\d{2}$/

export type ShareStatus = 'active' | 'revoked' | 'expired' | 'department_gone'

export interface ShareInput {
  tenant_id?: unknown; department_id?: unknown; doctor_id?: unknown
  scope?: unknown; allow_import?: unknown; days?: unknown; display_name?: unknown
}

export class ShareService {
  constructor(
    private readonly store: Store,
    private readonly tenants: TenantService,
    private readonly patients: PatientService,
    private readonly docs: Documents,
  ) {}

  // —— 目录（知家选医院 → 科室 → 医生）——

  /** 接受家庭分享的医院、科室、医生（只给名称）。 */
  directory(): Array<{ id: string; name: string; departments: Array<{ id: string; name: string; doctors: Array<{ id: string; display_name: string }> }> }> {
    return this.store.listTenants()
      .filter(t => t.kind === 'org' && t.status === 'active' && this.tenants.settings(t).accept_patient_shares)
      .map(t => ({
        id: t.id, name: t.name,
        departments: this.store.listDepartments(t.id).map(d => ({
          id: d.id, name: d.name,
          doctors: d.members.flatMap(id => { const u = this.store.getUser(id); return u && u.status === 'active' && u.tenant_id === t.id ? [{ id, display_name: u.display_name }] : [] }),
        })),
      }))
      .filter(t => t.departments.length > 0)
  }

  // —— 家人一侧 ——

  create(a: Actor, patientId: string, input: ShareInput) {
    const own = this.tenants.of(a.userId)
    if (own.kind !== 'personal') throw new PatientError('share_personal_only', '分享给医生只在知家（个人空间）里用；医院之间请走院内流程', 403)
    this.patients.assertEditable(a, patientId)
    const target = typeof input.tenant_id === 'string' ? this.store.getTenant(input.tenant_id) : undefined
    if (!target || target.kind !== 'org' || target.status !== 'active' || !this.tenants.settings(target).accept_patient_shares) throw new PatientError('bad_hospital', '这家医院不在可分享的列表里', 400)
    const dept = typeof input.department_id === 'string' ? this.store.getDepartment(input.department_id) : undefined
    if (!dept || dept.tenant_id !== target.id) throw new PatientError('bad_department', '请选择这家医院的科室', 400)
    let doctor: string | null = null
    if (typeof input.doctor_id === 'string' && input.doctor_id) {
      const u = this.store.getUser(input.doctor_id)
      if (!u || u.tenant_id !== target.id || u.status !== 'active' || !this.store.departmentsOfUser(u.id).includes(dept.id)) throw new PatientError('bad_doctor', '这位医生不在所选科室', 400)
      doctor = u.id
    }
    const scope = parseScope(input.scope)
    const days = DAYS.includes(Number(input.days)) ? Number(input.days) : 30
    const name = typeof input.display_name === 'string' ? input.display_name.trim().slice(0, 24) : ''
    const row = this.store.addShare({
      owner: a.userId, source_tenant_id: own.id, patient_id: patientId, tenant_id: target.id, department_id: dept.id, doctor_id: doctor,
      scope: JSON.stringify(scope), allow_import: input.allow_import === true ? 1 : 0, display_name_enc: name ? this.patients.sealText(own.id, name) : null,
      expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
    })
    this.patients.sharedLog(own.id, patientId, a.userId, a.via, 'share_create', `分享给 ${this.where(row)}（${days} 天）`)
    return this.ownerView(row)
  }

  /** 这位成员的全部分享（有效、撤销、过期、纳入情况）。 */
  listForPatient(a: Actor, patientId: string) {
    this.patients.assertEditable(a, patientId)
    return this.store.sharesOf(a.userId, patientId).map(s => this.ownerView(s))
  }

  revoke(a: Actor, shareId: string): void {
    const s = this.store.getShare(shareId)
    if (!s || s.owner !== a.userId) throw new PatientError('not_found', '分享不存在', 404)
    if (s.status === 'revoked') return
    this.store.revokeShare(s.id)
    this.patients.sharedLog(s.source_tenant_id, s.patient_id, a.userId, a.via, 'share_revoke', `撤销对 ${this.where(s)} 的分享`)
  }

  private ownerView(s: PhrShareRow) {
    const tenant = this.store.getTenant(s.tenant_id)
    const dept = this.store.getDepartment(s.department_id)
    const doctor = s.doctor_id ? this.store.getUser(s.doctor_id) : undefined
    const importer = s.imported_by ? this.store.getUser(s.imported_by) : undefined
    return {
      id: s.id, patient_id: s.patient_id, hospital: tenant?.name ?? '（医院已不存在）', department: dept?.name ?? '（科室已撤销）', doctor: doctor?.display_name ?? null,
      scope: JSON.parse(s.scope) as ShareScope, allow_import: Boolean(s.allow_import), display_name: this.patients.openText(s.source_tenant_id, s.display_name_enc),
      status: statusOf(s, Boolean(dept)), expires_at: s.expires_at, created_at: s.created_at, revoked_at: s.revoked_at,
      imported: s.imported_at ? { at: s.imported_at, by: importer?.display_name ?? null } : null,
    }
  }

  // —— 医生一侧 ——

  /** 本人所在科室收到的、或指定给本人的有效分享。 */
  inbox(a: Actor) {
    const t = this.tenants.of(a.userId)
    const settings = this.tenants.settings(t)
    if (!settings.accept_patient_shares) return []
    this.aiGate(a, settings)
    const mine = new Set(this.store.departmentsOfUser(a.userId))
    return this.store.sharesToTenant(t.id).filter(s => statusOf(s, Boolean(this.store.getDepartment(s.department_id))) === 'active' && (s.doctor_id ? s.doctor_id === a.userId : mine.has(s.department_id)))
      .map(s => this.doctorSummary(s, a))
  }

  /** 概况：基本信息、范围内的化验 / 报告 / 文档清单。记一次查看。 */
  read(a: Actor, shareId: string) {
    const s = this.forDoctor(a, shareId)
    const view = this.patients.sharedView(s.source_tenant_id, s.patient_id, scopeOf(s))
    this.patients.sharedLog(s.source_tenant_id, s.patient_id, a.userId, a.via, 'share_view', `${this.where(s)} · 查看概况`)
    const latest = [...new Map(view.labs.map(l => [l.test_key, l])).values()]
    return {
      ...this.doctorSummary(s, a), sex: view.sex, birth_year: view.birth_year, tags: view.tags,
      latest_labs: latest, lab_count: view.labs.length, records: view.records, documents: view.documents,
    }
  }

  labs(a: Actor, shareId: string, tests?: string[]) {
    const s = this.forDoctor(a, shareId)
    let labs = this.patients.sharedView(s.source_tenant_id, s.patient_id, scopeOf(s)).labs
    if (tests?.length) { const want = new Set(tests.map(t => t.toLowerCase())); labs = labs.filter(l => want.has(l.test_key.toLowerCase()) || want.has(l.test_name.toLowerCase())) }
    this.patients.sharedLog(s.source_tenant_id, s.patient_id, a.userId, a.via, 'share_labs', `${this.where(s)} · 查看化验`)
    return labs
  }

  file(a: Actor, shareId: string, fileId: string) {
    const s = this.forDoctor(a, shareId)
    const f = this.patients.sharedFile(s.source_tenant_id, s.patient_id, scopeOf(s), fileId)
    this.patients.sharedLog(s.source_tenant_id, s.patient_id, a.userId, a.via, 'share_file', `${this.where(s)} · 下载报告原件`)
    return f
  }

  /** 报告文字（已打码；给医生的 AI 读原件用）。 */
  recordText(a: Actor, shareId: string, recordId: string) {
    const s = this.forDoctor(a, shareId)
    const r = this.patients.sharedRecordText(s.source_tenant_id, s.patient_id, scopeOf(s), recordId)
    this.patients.sharedLog(s.source_tenant_id, s.patient_id, a.userId, a.via, 'share_record', `${this.where(s)} · 读报告「${r.title}」`)
    return r
  }

  /** 简报 / 健康档案（只读）：返回文档模型，由调用方渲染。 */
  doc(a: Actor, shareId: string, docId: string) {
    const s = this.forDoctor(a, shareId)
    const d = this.patients.sharedView(s.source_tenant_id, s.patient_id, scopeOf(s)).documents.find(x => x.doc_id === docId)
    if (!d) throw new PatientError('not_found', '文档不存在', 404)
    this.patients.sharedLog(s.source_tenant_id, s.patient_id, a.userId, a.via, 'share_doc', `${this.where(s)} · 查看「${kindLabel(d.kind)}」`)
    return { ...d, node: this.docs.get(docId) }
  }

  /** 纳入本院（家人允许时）：复制成本院患者，返回新患者。 */
  import(a: Actor, shareId: string) {
    const s = this.forDoctor(a, shareId)
    if (!s.allow_import) throw new PatientError('import_not_allowed', '家人没有允许纳入本院病历', 403)
    if (s.imported_at) throw new PatientError('already_imported', '这份分享已经纳入本院了', 409)
    const p = this.patients.importShared(a, { tenantId: s.source_tenant_id, patientId: s.patient_id, shareId: s.id, scope: scopeOf(s) }, (docId, kind) => {
      const src = this.store.getDoc(docId)
      if (!src || src.deleted_at) return null
      return this.docs.create({ owner: a.userId, title: `家庭分享 · ${kindLabel(kind)}（${new Date().toISOString().slice(0, 10)}）`, kind: src.kind, content: this.docs.get(docId) }).id
    })
    this.store.markShareImported(s.id, a.userId, p.id)
    this.patients.sharedLog(s.source_tenant_id, s.patient_id, a.userId, a.via, 'share_import', `${this.where(s)} · 纳入本院病历`)
    return p
  }

  /** 医生能看这份分享：本院收到、有效、本人在科室里（指定了医生时只能是那位医生）；看不到的当不存在。 */
  private forDoctor(a: Actor, shareId: string): PhrShareRow {
    const s = this.store.getShare(shareId)
    const t = this.tenants.of(a.userId)
    const settings = this.tenants.settings(t)
    const missing = () => new PatientError('not_found', '分享不存在或已失效', 404)
    if (!s || s.tenant_id !== t.id || !settings.accept_patient_shares) throw missing()
    if (statusOf(s, Boolean(this.store.getDepartment(s.department_id))) !== 'active') throw missing()
    if (s.doctor_id ? s.doctor_id !== a.userId : !this.store.departmentsOfUser(a.userId).includes(s.department_id)) throw missing()
    this.aiGate(a, settings)
    return s
  }

  private aiGate(a: Actor, settings: ReturnType<TenantService['settings']>): void {
    if (a.via === 'ai' && !settings.external_model_for_patients) throw new PatientError('external_model_off', '本机构设置为患者数据不交给外部模型分析', 403)
  }

  private doctorSummary(s: PhrShareRow, a: Actor) {
    return {
      share_id: s.id, share_code: `FS-${s.id.slice(2, 8).toUpperCase()}`, department: this.store.getDepartment(s.department_id)?.name ?? '',
      to_me: s.doctor_id === a.userId, scope: scopeOf(s), allow_import: Boolean(s.allow_import), expires_at: s.expires_at, shared_at: s.created_at,
      imported: s.imported_at ? { at: s.imported_at, patient_id: s.imported_patient_id } : null,
      // 给医生看的姓名：只给医生本人的界面，不给 AI
      ...(a.via === 'user' ? { display_name: this.patients.openText(s.source_tenant_id, s.display_name_enc) } : {}),
    }
  }

  /** 访问日志里的「谁在哪」：医院 · 科室 */
  private where(s: PhrShareRow): string {
    return `${this.store.getTenant(s.tenant_id)?.name ?? '医院'} · ${this.store.getDepartment(s.department_id)?.name ?? '科室'}`
  }
}

function parseScope(v: unknown): ShareScope {
  const o = (v && typeof v === 'object' ? v : {}) as { categories?: unknown; since?: unknown }
  const cats = Array.isArray(o.categories) ? CATEGORIES.filter(c => (o.categories as unknown[]).includes(c)) : [...CATEGORIES]
  if (cats.length === 0) throw new PatientError('bad_scope', '至少选一类要分享的内容')
  return { categories: cats, since: typeof o.since === 'string' && DATE.test(o.since) ? o.since : null }
}

const scopeOf = (s: PhrShareRow): ShareScope => JSON.parse(s.scope) as ShareScope

function statusOf(s: PhrShareRow, deptExists: boolean): ShareStatus {
  if (s.status === 'revoked') return 'revoked'
  if (Date.parse(s.expires_at) <= Date.now()) return 'expired'
  if (!deptExists) return 'department_gone'
  return 'active'
}

function kindLabel(kind: string): string {
  return ({ archive: '健康档案', brief: '就诊简报', case_report: '病例报告', followup: '随访小结', discussion: '讨论', other: '文档' } as Record<string, string>)[kind] ?? '文档'
}
