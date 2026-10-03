import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { TenantService, TenantSettings } from '../auth/tenants.ts'
import type { Store } from '../store/db.ts'
import type { TenantKeys } from './keys.ts'
import type { Complete } from '../memory/evolve.ts'
import { extractReport, redact } from './extract-report.ts'
import { standardize, standardizeRange } from './units.ts'

/**
 * 患者数据（docs/design/TENANCY.md §2、§4；患者模块第二期的底座）。
 * - **每个机构一个库文件**：data/tenants/<机构>/patients.db 与 files/。连接本身只属于一个机构，查询写错也读不到别的机构。
 * - 患者只有代号（P-0001）、性别、出生年份、诊断标签；**不存姓名**（代号 ↔ 姓名只在医生自己的浏览器里）。
 * - 原始报告文件、文件名、自由文本用机构数据密钥加密（keys.ts）。
 * - 可见范围：诊疗组（创建者 + 被加入的成员），或机构设置为本机构全员；机构管理员不自动可见，查看要走紧急访问（填理由、24 小时、留痕）。
 *   看不到的患者一律当不存在（不暴露存在与否）。
 * - 每次查看、下载、导出都记访问日志（谁、何时、做了什么）。
 * - AI 与人操作能力相同（经 MCP，以当前用户身份，访问日志标明 AI）。机构设置 ai_patient_writes：
 *   review（默认）= AI 的写入进待确认 / 提议，由医生确认；direct = 和人一样直接生效。确认化验、确认报告这类「审核」本身在 review 模式下只能由人做。
 *   两项不给 AI：删除患者（不可恢复，与文档一致）、紧急访问（机构管理员以个人名义承担，理由须本人填写）。
 * - 化验日期是报告上的日期（collected_on），不是上传时间（v1 的教训）。
 */

export class PatientError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 = 400) { super(message) }
}

export interface PatientRow {
  id: string; code: string; sex: 'M' | 'F' | null; birth_year: number | null; tags: string[]
  status: 'active' | 'archived'; created_by: string; created_at: string; updated_at: string
}
export interface LabRow {
  id: string; patient_id: string; record_id: string | null; test_key: string; test_name: string
  value_num: number | null; value_text: string | null; unit: string | null
  ref_low: number | null; ref_high: number | null; ref_text: string | null; flag: 'H' | 'L' | null
  /** 报告上的日期；提取时报告上没写日期的为 null，确认报告时由医生补填 */
  collected_on: string | null; status: 'pending' | 'confirmed' | 'rejected' | 'superseded'; source: 'manual' | 'extracted' | 'ai'
  locator: { page?: number; bbox?: number[]; verified?: boolean } | null
  /** 采样时间（报告上有时间时，YYYY-MM-DD HH:MM），同一天多次检查按它排序 */
  collected_at: string | null
  /** 审核时医生选择「用这个替换」的旧值（同日同项的已确认化验）；确认后旧值标为 superseded */
  replaces: string | null
  /** 换算到标准单位后的值、单位、参考范围（原始值不变，见 units.ts） */
  std_value: number | null; std_unit: string | null; std_ref_low: number | null; std_ref_high: number | null; converted: boolean; unknown_unit: boolean
  created_by: string; created_at: string; confirmed_by: string | null; confirmed_at: string | null
}
export interface RecordRow {
  id: string; patient_id: string; kind: 'lab_report' | 'discharge' | 'pathology' | 'imaging' | 'note' | 'other'
  title: string; report_date: string | null; file_id: string | null; status: 'pending' | 'confirmed' | 'rejected'
  /** 自动提取：排队 / 进行中 / 完成 / 失败 / 跳过（机构不允许交给外部模型，或没有可读文字） */
  extraction: 'queued' | 'running' | 'done' | 'failed' | 'skipped' | null; extraction_note: string | null
  created_by: string; created_at: string; confirmed_by: string | null; confirmed_at: string | null
}

/** 报告文字：PDF（文字层 / 扫描件 OCR）、图片（OCR）→ 每页文字。 */
export type ReportPages = (name: string, mime: string, bytes: Uint8Array) => Promise<string[]>
export interface ProposalRow {
  id: string; patient_id: string; kind: 'lab' | 'tag' | 'note' | 'update' | 'enroll' | 'unenroll'; payload: Record<string, unknown>; reason: string
  turn_id: string | null; status: 'pending' | 'accepted' | 'rejected'; created_by: string; created_at: string; resolved_by: string | null; resolved_at: string | null
}

const now = () => new Date().toISOString()
const rid = (p: string) => p + randomUUID().replace(/-/g, '').slice(0, 12)
const DATE = /^\d{4}-\d{2}-\d{2}$/
const BREAK_GLASS_HOURS = 24

/** 化验项目名 → 标准键（同一项目不同叫法归一）。常见的先列，其余用规范化后的原名。 */
const TEST_ALIASES: Array<[RegExp, string]> = [
  [/^(alt|gpt|谷丙转氨酶|丙氨酸氨基转移酶)$/i, 'alt'], [/^(ast|got|谷草转氨酶|天门冬氨酸氨基转移酶)$/i, 'ast'],
  [/^(cr|crea|scr|肌酐|血肌酐)$/i, 'creatinine'], [/^(egfr|估算肾小球滤过率)$/i, 'egfr'],
  [/^(hba1c|糖化血红蛋白)$/i, 'hba1c'], [/^(glu|fpg|葡萄糖|空腹血糖|血糖)$/i, 'glucose'],
  [/^(tc|chol|总胆固醇)$/i, 'cholesterol'], [/^(tg|甘油三酯)$/i, 'triglycerides'], [/^(ldl-?c|低密度脂蛋白胆固醇)$/i, 'ldl'], [/^(hdl-?c|高密度脂蛋白胆固醇)$/i, 'hdl'],
  [/^(wbc|白细胞|白细胞计数)$/i, 'wbc'], [/^(hb|hgb|血红蛋白)$/i, 'hemoglobin'], [/^(plt|血小板|血小板计数)$/i, 'platelets'],
  [/^(alb|白蛋白)$/i, 'albumin'], [/^(tbil|总胆红素)$/i, 'bilirubin'], [/^(ua|尿酸)$/i, 'uric_acid'], [/^(k|钾|血钾)$/i, 'potassium'],
  [/^(tp|总蛋白)$/i, 'total_protein'], [/^(urea|bun|尿素|尿素氮)$/i, 'urea'], [/^(na|钠|血钠)$/i, 'sodium'], [/^(cl|氯|血氯)$/i, 'chloride'],
  [/^(bnp|脑钠肽)$/i, 'bnp'], [/^(nt-?probnp|n末端脑钠肽前体)$/i, 'nt_probnp'], [/^(crp|c反应蛋白)$/i, 'crp'],
]
export function testKey(name: string): string {
  // 报告常写「中文名(缩写)」：整体、括号里的缩写、括号外的中文名依次试
  const whole = name.trim().replace(/\s+/g, '')
  const inner = /[（(]([^（）()]+)[）)]/.exec(whole)?.[1] ?? ''
  const outer = whole.replace(/[（(][^（）()]*[）)]/g, '')
  for (const n of [whole.replace(/[（）()]/g, ''), inner, outer]) {
    if (!n) continue
    for (const [re, key] of TEST_ALIASES) if (re.test(n)) return key
  }
  return (outer || whole).toLowerCase()
}

/** 一个机构的患者库（库文件 + 加密文件目录）。只由 PatientService 打开。 */
class TenantPatientDb {
  readonly db: DatabaseSync
  readonly files: string

  constructor(root: string, readonly tenantId: string) {
    const dir = join(root, tenantId.replace(/[^A-Za-z0-9_-]/g, '_'))
    this.files = join(dir, 'files')
    mkdirSync(this.files, { recursive: true })
    this.db = new DatabaseSync(join(dir, 'patients.db'))
    this.db.exec(`
      PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS seq (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS patients (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, sex TEXT, birth_year INTEGER, tags TEXT NOT NULL DEFAULT '[]', summary_enc TEXT,
        status TEXT NOT NULL DEFAULT 'active', created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS care_team (
        patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, user_id TEXT NOT NULL, role TEXT NOT NULL,
        added_by TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (patient_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, name_enc TEXT NOT NULL, mime TEXT NOT NULL,
        size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, kind TEXT NOT NULL, title TEXT NOT NULL,
        report_date TEXT, report_time TEXT, file_id TEXT, status TEXT NOT NULL, text_enc TEXT, extraction TEXT, extraction_note TEXT,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL, confirmed_by TEXT, confirmed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS labs (
        id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, record_id TEXT, test_key TEXT NOT NULL, test_name TEXT NOT NULL,
        value_num REAL, value_text TEXT, unit TEXT, ref_low REAL, ref_high REAL, ref_text TEXT, flag TEXT, collected_on TEXT,
        status TEXT NOT NULL, source TEXT NOT NULL, locator TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, confirmed_by TEXT, confirmed_at TEXT,
        collected_at TEXT, replaces TEXT
      );
      CREATE INDEX IF NOT EXISTS labs_patient ON labs (patient_id, test_key, collected_on);
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, kind TEXT NOT NULL, payload TEXT NOT NULL, reason TEXT NOT NULL,
        turn_id TEXT, status TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, resolved_by TEXT, resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS patient_docs (
        patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, doc_id TEXT NOT NULL, kind TEXT NOT NULL,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (patient_id, doc_id)
      );
      CREATE TABLE IF NOT EXISTS access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id TEXT NOT NULL, patient_id TEXT NOT NULL, action TEXT NOT NULL, via TEXT NOT NULL, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS access_log_patient ON access_log (patient_id, at);
      CREATE TABLE IF NOT EXISTS break_glass (
        id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, user_id TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      -- 研究入组（docs/design/COHORT.md）：患者 ↔ 研究的对应与研究编号放在机构的患者库里，不进平台库
      CREATE TABLE IF NOT EXISTS enrollments (
        study_id TEXT NOT NULL, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, subject_id TEXT NOT NULL,
        status TEXT NOT NULL, criteria TEXT, enrolled_by TEXT NOT NULL, enrolled_at TEXT NOT NULL, withdrawn_at TEXT,
        PRIMARY KEY (study_id, patient_id), UNIQUE (study_id, subject_id)
      );
    `)
    // 旧库补列
    const cols = (t: string) => (this.db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name)
    const labCols = cols('labs')
    if (!labCols.includes('collected_at')) this.db.exec('ALTER TABLE labs ADD COLUMN collected_at TEXT')
    if (!labCols.includes('replaces')) this.db.exec('ALTER TABLE labs ADD COLUMN replaces TEXT')
    if (!cols('records').includes('report_time')) this.db.exec('ALTER TABLE records ADD COLUMN report_time TEXT')
  }

  /** 研究内的研究编号 S001、S002……（递增，移出的不复用） */
  nextSubject(studyId: string): string {
    const row = this.db.prepare("INSERT INTO seq (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value").get(`subject:${studyId}`) as { value: number }
    return `S${String(row.value).padStart(3, '0')}`
  }

  nextCode(): string {
    const row = this.db.prepare("INSERT INTO seq (name, value) VALUES ('patient', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value").get() as { value: number }
    return `P-${String(row.value).padStart(4, '0')}`
  }

  close(): void { this.db.close() }
}

const patientOf = (r: Record<string, unknown>): PatientRow => ({
  id: r.id as string, code: r.code as string, sex: (r.sex as PatientRow['sex']) ?? null, birth_year: (r.birth_year as number | null) ?? null,
  tags: JSON.parse((r.tags as string) || '[]') as string[], status: r.status as PatientRow['status'],
  created_by: r.created_by as string, created_at: r.created_at as string, updated_at: r.updated_at as string,
})
const labOf = (r: Record<string, unknown>): LabRow => {
  const l = r as unknown as LabRow
  const std = standardize(l.test_key, l.value_num, l.unit)
  const range = standardizeRange(l.test_key, l.ref_low, l.ref_high, l.unit)
  return { ...l, locator: r.locator ? JSON.parse(r.locator as string) : null, collected_at: (r.collected_at as string | null) ?? null, replaces: (r.replaces as string | null) ?? null,
    std_value: std.value, std_unit: std.unit, std_ref_low: range.low, std_ref_high: range.high, converted: std.converted, unknown_unit: std.unknown_unit }
}
const proposalOf = (r: Record<string, unknown>): ProposalRow => ({ ...(r as unknown as ProposalRow), payload: JSON.parse(r.payload as string) })

export interface Actor {
  userId: string
  /** ai = AI 经 MCP 代该用户访问（访问日志里区分） */
  via: 'user' | 'ai'
  turnId?: string | null
}

export class PatientService {
  private dbs = new Map<string, TenantPatientDb>()
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly root: string,
    private readonly tenants: TenantService,
    private readonly keys: TenantKeys,
    private readonly store: Store,
    /** 报告自动提取（没有时上传的报告只能手工录入）。 */
    private readonly extractor: { pages: ReportPages; complete: Complete | null } | null = null,
  ) {}

  /** 等后台提取完（测试用）。 */
  idle(): Promise<void> { return this.queue }

  // —— 机构与权限 ——

  /** 打开操作者所在机构的患者库。机构不开患者模块时拒绝。 */
  private ctx(a: Actor): { db: TenantPatientDb; tenantId: string; settings: TenantSettings; tenantAdmin: boolean } {
    const t = this.tenants.of(a.userId)
    const settings = this.tenants.settings(t)
    if (!settings.patient_module) throw new PatientError('patient_module_off', '本机构没有启用患者模块', 403)
    if (a.via === 'ai' && !settings.external_model_for_patients) throw new PatientError('external_model_off', '本机构设置为患者数据不交给外部模型分析', 403)
    let db = this.dbs.get(t.id)
    if (!db) { db = new TenantPatientDb(this.root, t.id); this.dbs.set(t.id, db) }
    return { db, tenantId: t.id, settings, tenantAdmin: this.tenants.roleOf(a.userId) === 'admin' }
  }

  /** AI 写入要不要先经医生确认（机构设置）。 */
  private aiReview(a: Actor, c: { settings: TenantSettings }): boolean {
    return a.via === 'ai' && c.settings.ai_patient_writes !== 'direct'
  }

  /** review 模式下 AI 不能做审核动作（确认 / 驳回）。 */
  private noAiReview(a: Actor, c: { settings: TenantSettings }, what: string): void {
    if (this.aiReview(a, c)) throw new PatientError('needs_human_review', `${what}需要医生在「待确认」里操作（本机构设置为 AI 的修改需医生确认）`, 403)
  }

  private teamRole(db: TenantPatientDb, patientId: string, userId: string): 'owner' | 'member' | null {
    return (db.db.prepare('SELECT role FROM care_team WHERE patient_id = ? AND user_id = ?').get(patientId, userId) as { role: 'owner' | 'member' } | undefined)?.role ?? null
  }

  private breakGlassActive(db: TenantPatientDb, patientId: string, userId: string): boolean {
    return Boolean(db.db.prepare('SELECT 1 FROM break_glass WHERE patient_id = ? AND user_id = ? AND expires_at > ?').get(patientId, userId, now()))
  }

  /** 能看到的患者；看不到的当不存在。 */
  private visible(a: Actor, patientId: string): { c: ReturnType<PatientService['ctx']>; p: PatientRow; role: 'owner' | 'member' | 'tenant' | 'break_glass' } {
    const c = this.ctx(a)
    const r = c.db.db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId) as Record<string, unknown> | undefined
    if (!r) throw new PatientError('not_found', '患者不存在', 404)
    const team = this.teamRole(c.db, patientId, a.userId)
    const role = team ?? (c.settings.patient_visibility === 'tenant' ? 'tenant' : this.breakGlassActive(c.db, patientId, a.userId) ? 'break_glass' : null)
    if (!role) throw new PatientError('not_found', '患者不存在', 404)
    return { c, p: patientOf(r), role }
  }

  private log(c: { db: TenantPatientDb }, a: Actor, patientId: string, action: string, detail: string | null = null): void {
    c.db.db.prepare('INSERT INTO access_log (at, user_id, patient_id, action, via, detail) VALUES (?, ?, ?, ?, ?, ?)').run(now(), a.userId, patientId, action, a.via, detail)
  }

  // —— 患者 ——

  create(a: Actor, input: { sex?: unknown; birth_year?: unknown; tags?: unknown }): PatientRow {
    const c = this.ctx(a)
    const id = rid('pt')
    const t = now()
    c.db.db.prepare('INSERT INTO patients (id, code, sex, birth_year, tags, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, c.db.nextCode(), sex(input.sex), birthYear(input.birth_year), JSON.stringify(tags(input.tags)), a.userId, t, t)
    c.db.db.prepare('INSERT INTO care_team (patient_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)').run(id, a.userId, 'owner', a.userId, t)
    this.log(c, a, id, 'create')
    return this.visible(a, id).p
  }

  list(a: Actor): Array<PatientRow & { role: string; labs: number; last_lab: string | null; pending: number }> {
    const c = this.ctx(a)
    const rows = (c.settings.patient_visibility === 'tenant'
      ? c.db.db.prepare('SELECT * FROM patients ORDER BY updated_at DESC').all()
      : c.db.db.prepare(`SELECT p.* FROM patients p WHERE p.id IN (SELECT patient_id FROM care_team WHERE user_id = ?)
          OR p.id IN (SELECT patient_id FROM break_glass WHERE user_id = ? AND expires_at > ?) ORDER BY p.updated_at DESC`).all(a.userId, a.userId, now())) as Array<Record<string, unknown>>
    return rows.map(r => {
      const p = patientOf(r)
      const stats = c.db.db.prepare("SELECT COUNT(*) AS n, MAX(collected_on) AS last FROM labs WHERE patient_id = ? AND status = 'confirmed'").get(p.id) as { n: number; last: string | null }
      const pending = (c.db.db.prepare("SELECT (SELECT COUNT(*) FROM labs WHERE patient_id = ? AND status = 'pending') + (SELECT COUNT(*) FROM proposals WHERE patient_id = ? AND status = 'pending') AS n").get(p.id, p.id) as { n: number }).n
      return { ...p, role: this.teamRole(c.db, p.id, a.userId) ?? (c.settings.patient_visibility === 'tenant' ? 'tenant' : 'break_glass'), labs: stats.n, last_lab: stats.last, pending }
    })
  }

  /** 概况：基本信息、诊疗组、报告、各项化验的最近值。记一次查看。 */
  read(a: Actor, patientId: string) {
    const { c, p, role } = this.visible(a, patientId)
    const summary = c.db.db.prepare('SELECT summary_enc FROM patients WHERE id = ?').get(patientId) as { summary_enc: string | null }
    const team = (c.db.db.prepare('SELECT user_id, role, added_at FROM care_team WHERE patient_id = ? ORDER BY added_at').all(patientId) as Array<{ user_id: string; role: string; added_at: string }>)
      .map(m => ({ ...m, name: this.store.getUser(m.user_id)?.display_name ?? m.user_id }))
    const records = (c.db.db.prepare('SELECT * FROM records WHERE patient_id = ? ORDER BY COALESCE(report_date, created_at) DESC').all(patientId) as unknown as RecordRow[])
      .map(r => ({ ...r, text_enc: undefined }))
    // 每项最近一次（同一天多次时取采样时间最晚、再取录入最晚的）
    const all = (c.db.db.prepare("SELECT * FROM labs WHERE patient_id = ? AND status = 'confirmed' ORDER BY test_key, collected_on, COALESCE(collected_at, collected_on), created_at").all(patientId) as Array<Record<string, unknown>>).map(labOf)
    const latest = [...new Map(all.map(l => [l.test_key, l])).values()]
    this.log(c, a, patientId, 'view')
    return { ...p, access: role, documents: this.documents(c, patientId, a.userId), studies: this.studiesOf(c, patientId), summary: this.keys.decryptText(c.tenantId, summary.summary_enc), care_team: team, records, latest_labs: latest, pending_proposals: this.proposals(a, patientId, c) }
  }

  update(a: Actor, patientId: string, patch: { sex?: unknown; birth_year?: unknown; tags?: unknown; summary?: unknown; status?: unknown }): PatientRow {
    const { c } = this.requireTeam(a, patientId)
    if (this.aiReview(a, c)) {
      // 需医生确认：作为一条「修改」提议
      const clean: Record<string, unknown> = {}
      for (const k of ['sex', 'birth_year', 'tags', 'summary', 'status'] as const) if (patch[k] !== undefined) clean[k] = patch[k]
      if (patch.birth_year !== undefined) birthYear(patch.birth_year)
      this.propose(a, patientId, { kind: 'update', payload: clean, reason: typeof (patch as { reason?: unknown }).reason === 'string' ? (patch as { reason: string }).reason : 'AI 修改患者信息' })
      return this.visible(a, patientId).p
    }
    const sets: string[] = []
    const args: Array<string | number | null> = []
    if (patch.sex !== undefined) { sets.push('sex = ?'); args.push(sex(patch.sex)) }
    if (patch.birth_year !== undefined) { sets.push('birth_year = ?'); args.push(birthYear(patch.birth_year)) }
    if (patch.tags !== undefined) { sets.push('tags = ?'); args.push(JSON.stringify(tags(patch.tags))) }
    if (typeof patch.summary === 'string') { sets.push('summary_enc = ?'); args.push(this.keys.encryptText(c.tenantId, patch.summary.slice(0, 5000))) }
    if (patch.status === 'active' || patch.status === 'archived') { sets.push('status = ?'); args.push(patch.status) }
    if (sets.length) c.db.db.prepare(`UPDATE patients SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, now(), patientId)
    this.log(c, a, patientId, 'update', Object.keys(patch).join(','))
    return this.visible(a, patientId).p
  }

  /** 删除患者（只有负责人）：库里的记录与加密文件一起删。 */
  remove(a: Actor, patientId: string): void {
    if (a.via === 'ai') throw new PatientError('forbidden', '删除患者不可恢复，只能由负责人在界面上操作', 403)
    const { c } = this.requireTeam(a, patientId, 'owner')
    for (const f of c.db.db.prepare('SELECT id FROM files WHERE patient_id = ?').all(patientId) as Array<{ id: string }>) rmSync(join(c.db.files, f.id), { force: true })
    c.db.db.prepare('DELETE FROM patients WHERE id = ?').run(patientId)
    this.log(c, a, patientId, 'delete')
  }

  /** 诊疗组成员才能改（机构全员可见 / 紧急访问只能看）。 */
  private requireTeam(a: Actor, patientId: string, need: 'owner' | 'member' = 'member') {
    const v = this.visible(a, patientId)
    if (v.role !== 'owner' && (need === 'owner' || v.role !== 'member')) throw new PatientError('forbidden', need === 'owner' ? '只有负责人能做这件事' : '只有诊疗组成员能修改', 403)
    return v
  }

  // —— 诊疗组与紧急访问 ——

  addMember(a: Actor, patientId: string, userId: string): void {
    const { c } = this.requireTeam(a, patientId, 'owner')
    const u = this.store.getUser(userId)
    if (!u || u.tenant_id !== c.tenantId || u.status !== 'active') throw new PatientError('not_found', '本机构没有这位成员', 404)
    c.db.db.prepare('INSERT OR IGNORE INTO care_team (patient_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)').run(patientId, userId, 'member', a.userId, now())
    this.log(c, a, patientId, 'team_add', userId)
  }

  removeMember(a: Actor, patientId: string, userId: string): void {
    const { c } = this.requireTeam(a, patientId, 'owner')
    if (userId === a.userId) throw new PatientError('self', '负责人不能把自己移出诊疗组', 409)
    c.db.db.prepare("DELETE FROM care_team WHERE patient_id = ? AND user_id = ? AND role = 'member'").run(patientId, userId)
    this.log(c, a, patientId, 'team_remove', userId)
  }

  /** 紧急访问：机构管理员填写理由后获得 24 小时只读访问，记访问日志与审计。 */
  breakGlass(a: Actor, patientId: string, reason: unknown): { expires_at: string } {
    if (a.via === 'ai') throw new PatientError('forbidden', 'AI 不能申请紧急访问', 403)
    const c = this.ctx(a)
    if (!c.tenantAdmin) throw new PatientError('forbidden', '只有机构管理员能紧急访问', 403)
    const why = typeof reason === 'string' ? reason.trim() : ''
    if (why.length < 10) throw new PatientError('reason_required', '请写明紧急访问的理由（至少 10 个字）')
    if (!c.db.db.prepare('SELECT 1 FROM patients WHERE id = ?').get(patientId)) throw new PatientError('not_found', '患者不存在', 404)
    const expires = new Date(Date.now() + BREAK_GLASS_HOURS * 3600_000).toISOString()
    c.db.db.prepare('INSERT INTO break_glass (id, patient_id, user_id, reason, at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(rid('bg'), patientId, a.userId, why.slice(0, 500), now(), expires)
    this.log(c, a, patientId, 'break_glass', why.slice(0, 500))
    this.store.addAudit({ actor: a.userId, action: 'patient.break_glass', target: `患者 ${patientId}`, detail: why.slice(0, 200), tenant_id: c.tenantId })
    return { expires_at: expires }
  }

  /** 机构管理员紧急访问前要知道患者存在：只给代号（不给内容）。 */
  directory(a: Actor): Array<{ id: string; code: string }> {
    const c = this.ctx(a)
    if (!c.tenantAdmin) throw new PatientError('forbidden', '只有机构管理员能看患者目录', 403)
    return c.db.db.prepare('SELECT id, code FROM patients ORDER BY code').all() as Array<{ id: string; code: string }>
  }

  accessLog(a: Actor, patientId: string): Array<{ at: string; user: string; action: string; via: string; detail: string | null }> {
    const { c } = this.requireTeam(a, patientId, 'owner')
    return (c.db.db.prepare('SELECT * FROM access_log WHERE patient_id = ? ORDER BY id DESC LIMIT 500').all(patientId) as Array<{ at: string; user_id: string; action: string; via: string; detail: string | null }>)
      .map(r => ({ at: r.at, user: this.store.getUser(r.user_id)?.display_name ?? r.user_id, action: r.action, via: r.via, detail: r.detail }))
  }

  // —— 化验 ——

  /** 人录入 / 确认的化验值直接生效；AI 走 propose。 */
  addLab(a: Actor, patientId: string, input: Record<string, unknown>, opts: { status?: LabRow['status']; source?: LabRow['source']; recordId?: string | null } = {}): LabRow {
    if (a.via === 'ai') throw new PatientError('forbidden', '化验要来自上传的报告：用 report_upload 上传，或在报告上 report_lab_add 补项', 403)
    const { c } = this.requireTeam(a, patientId)
    const lab = labInput(input)
    const id = rid('lb')
    const status = opts.status ?? 'confirmed'
    c.db.db.prepare(`INSERT INTO labs (id, patient_id, record_id, test_key, test_name, value_num, value_text, unit, ref_low, ref_high, ref_text, flag, collected_on, status, source, locator, created_by, created_at, confirmed_by, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, patientId, opts.recordId ?? null, testKey(lab.test_name), lab.test_name, lab.value_num, lab.value_text, lab.unit,
      lab.ref_low, lab.ref_high, lab.ref_text, flagOf(lab), lab.collected_on, status, opts.source ?? 'manual', lab.locator ? JSON.stringify(lab.locator) : null, a.userId, now(),
      status === 'confirmed' ? a.userId : null, status === 'confirmed' ? now() : null)
    c.db.db.prepare('UPDATE patients SET updated_at = ? WHERE id = ?').run(now(), patientId)
    this.log(c, a, patientId, 'lab_add', lab.test_name)
    return labOf(c.db.db.prepare('SELECT * FROM labs WHERE id = ?').get(id) as Record<string, unknown>)
  }

  setLabStatus(a: Actor, patientId: string, labId: string, status: 'confirmed' | 'rejected'): void {
    const { c } = this.requireTeam(a, patientId)
    this.noAiReview(a, c, status === 'confirmed' ? '确认化验' : '删除待确认的化验')
    if (status === 'confirmed' && (c.db.db.prepare('SELECT collected_on FROM labs WHERE id = ?').get(labId) as { collected_on: string | null } | undefined)?.collected_on === null) {
      throw new PatientError('date_required', '这条化验没有日期，请先填写报告日期')
    }
    const r = c.db.db.prepare("UPDATE labs SET status = ?, confirmed_by = ?, confirmed_at = ? WHERE id = ? AND patient_id = ? AND status = 'pending'").run(status, a.userId, now(), labId, patientId)
    if (Number(r.changes) === 0) throw new PatientError('not_found', '没有待确认的这条化验', 404)
    this.log(c, a, patientId, status === 'confirmed' ? 'lab_confirm' : 'lab_reject', labId)
  }

  /** 同日同项的已确认化验（审核时提示冲突、确认时去重）。 */
  private sameDay(db: TenantPatientDb, patientId: string, l: { id: string; test_key: string; collected_on: string | null }): LabRow[] {
    if (!l.collected_on) return []
    return (db.db.prepare("SELECT * FROM labs WHERE patient_id = ? AND test_key = ? AND collected_on = ? AND status = 'confirmed' AND id != ?").all(patientId, l.test_key, l.collected_on, l.id) as Array<Record<string, unknown>>).map(labOf)
  }

  /** 化验长表（只含已确认的；includePending 给审核界面用）。 */
  labs(a: Actor, patientId: string, f: { tests?: string[]; from?: string; to?: string; includePending?: boolean } = {}): Array<LabRow & { same_day?: LabRow[] }> {
    const { c } = this.visible(a, patientId)
    const where = ['patient_id = ?', f.includePending ? "status IN ('confirmed', 'pending')" : "status = 'confirmed'"]
    const args: string[] = [patientId]
    if (f.from && DATE.test(f.from)) { where.push('collected_on >= ?'); args.push(f.from) }
    if (f.to && DATE.test(f.to)) { where.push('collected_on <= ?'); args.push(f.to) }
    let rows: Array<LabRow & { same_day?: LabRow[] }> = (c.db.db.prepare(`SELECT * FROM labs WHERE ${where.join(' AND ')} ORDER BY test_key, collected_on, COALESCE(collected_at, collected_on), created_at`).all(...args) as Array<Record<string, unknown>>).map(labOf)
    if (f.tests?.length) { const keys = new Set(f.tests.map(testKey)); rows = rows.filter(r => keys.has(r.test_key)) }
    // 待确认的项：带上同日同项已确认的值（审核时决定替换还是都保留）
    if (f.includePending) rows = rows.map(r => r.status === 'pending' ? { ...r, same_day: this.sameDay(c.db, patientId, r) } : r)
    this.log(c, a, patientId, 'labs_read', f.tests?.join(',') ?? null)
    return rows
  }

  /** 化验长表导出成 CSV（AI 放进工作区分析用；不含任何身份信息）。 */
  labsCsv(a: Actor, patientId: string): { code: string; csv: string; rows: number } {
    const { p } = this.visible(a, patientId)
    const rows = this.labs(a, patientId)
    const q = (v: unknown) => v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)
    // value / unit 是换算到标准单位后的（便于画趋势、做统计）；orig_value / orig_unit 是报告上的原样
    const head = 'patient,test_key,test_name,value,unit,ref_low,ref_high,flag,collected_on,collected_at,orig_value,orig_unit,value_text'
    const body = rows.map(r => [p.code, r.test_key, r.test_name, r.std_value, r.std_unit, r.std_ref_low, r.std_ref_high, r.flag, r.collected_on, r.collected_at, r.value_num, r.unit, r.value_text].map(q).join(','))
    return { code: p.code, csv: [head, ...body].join('\n') + '\n', rows: rows.length }
  }

  // —— 文件与报告 ——

  /** 上传原始报告：内容与文件名用机构密钥加密存盘，生成一条待确认的报告记录。 */
  addFile(a: Actor, patientId: string, input: { name: string; mime: string; bytes: Uint8Array; kind?: RecordRow['kind']; report_date?: string | null; title?: string }): { file_id: string; record: RecordRow } {
    const { c } = this.requireTeam(a, patientId)
    if (input.bytes.byteLength > 30 * 1024 * 1024) throw new PatientError('too_large', '文件超过 30 MB')
    // 同一份报告重复上传：拦下并说明是哪次传过的（不再重复提取）
    const sha = createHash('sha256').update(input.bytes).digest('hex')
    const dup = c.db.db.prepare(`SELECT r.title, r.report_date, f.created_at FROM files f LEFT JOIN records r ON r.file_id = f.id WHERE f.patient_id = ? AND f.sha256 = ? AND COALESCE(r.status, '') != 'rejected'`).get(patientId, sha) as { title: string | null; report_date: string | null; created_at: string } | undefined
    if (dup) throw new PatientError('duplicate', `这份报告已经上传过（${dup.created_at.slice(0, 10)} 上传${dup.title ? `，「${dup.title}」` : ''}${dup.report_date ? `，报告日期 ${dup.report_date}` : ''}）`, 409)
    const fid = rid('pf')
    writeFileSync(join(c.db.files, fid), this.keys.encrypt(c.tenantId, Buffer.from(input.bytes)))
    c.db.db.prepare('INSERT INTO files (id, patient_id, name_enc, mime, size, sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(fid, patientId, this.keys.encryptText(c.tenantId, input.name)!, input.mime, input.bytes.byteLength, sha, a.userId, now())
    const recId = rid('rc')
    const kind = input.kind && ['lab_report', 'discharge', 'pathology', 'imaging', 'note', 'other'].includes(input.kind) ? input.kind : 'other'
    // 自动提取：机构允许交给外部模型、配置了模型时排队；否则跳过，由医生手工录入
    const canExtract = Boolean(this.extractor?.complete) && c.settings.external_model_for_patients
    c.db.db.prepare('INSERT INTO records (id, patient_id, kind, title, report_date, file_id, status, extraction, extraction_note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(recId, patientId, kind, (input.title ?? '').trim().slice(0, 120) || '未命名报告', input.report_date && DATE.test(input.report_date) ? input.report_date : null, fid, 'pending',
        canExtract ? 'queued' : 'skipped', canExtract ? null : this.extractor?.complete ? '本机构设置为患者数据不交给外部模型，不能自动提取：请在审核里对照原件逐项添加' : '没有配置模型，不能自动提取：请在审核里对照原件逐项添加', a.userId, now())
    this.log(c, a, patientId, 'file_upload', fid)
    if (canExtract) {
      const tenantId = c.tenantId
      this.queue = this.queue.then(() => this.runExtraction(tenantId, patientId, recId, a.userId)).catch(err => console.error('[patient-extract]', err))
    }
    return { file_id: fid, record: c.db.db.prepare('SELECT * FROM records WHERE id = ?').get(recId) as unknown as RecordRow }
  }

  file(a: Actor, patientId: string, fileId: string): { name: string; mime: string; bytes: Buffer } {
    const { c } = this.visible(a, patientId)
    const f = c.db.db.prepare('SELECT * FROM files WHERE id = ? AND patient_id = ?').get(fileId, patientId) as { id: string; name_enc: string; mime: string } | undefined
    if (!f || !existsSync(join(c.db.files, f.id))) throw new PatientError('not_found', '文件不存在', 404)
    this.log(c, a, patientId, 'file_download', fileId)
    return { name: this.keys.decryptText(c.tenantId, f.name_enc)!, mime: f.mime, bytes: this.keys.decrypt(c.tenantId, readFileSync(join(c.db.files, f.id))) }
  }

  /** 后台提取：解密原文 → 每页文字 → 打码后交给模型 → 待确认的化验（带页码、原文核对结果）。 */
  private async runExtraction(tenantId: string, patientId: string, recordId: string, userId: string): Promise<void> {
    const db = this.dbs.get(tenantId)
    if (!db || !this.extractor?.complete) return
    const rec = db.db.prepare('SELECT * FROM records WHERE id = ?').get(recordId) as (RecordRow & { file_id: string }) | undefined
    if (!rec) return
    const set = (extraction: RecordRow['extraction'], note: string | null) => db.db.prepare('UPDATE records SET extraction = ?, extraction_note = ? WHERE id = ?').run(extraction, note, recordId)
    set('running', null)
    try {
      const f = db.db.prepare('SELECT name_enc, mime FROM files WHERE id = ?').get(rec.file_id) as { name_enc: string; mime: string }
      const name = this.keys.decryptText(tenantId, f.name_enc)!
      const bytes = this.keys.decrypt(tenantId, readFileSync(join(db.files, rec.file_id)))
      const pages = await this.extractor.pages(name, f.mime, bytes)
      if (pages.join('').trim().length < 20) { set('skipped', '没有识别出文字（照片不清楚？可以重新拍一张清晰的上传），或在审核里对照原件逐项添加'); return }
      db.db.prepare('UPDATE records SET text_enc = ? WHERE id = ?').run(this.keys.encryptText(tenantId, pages.join('\f')), recordId)
      const r = await extractReport(pages, this.extractor.complete)
      const date = rec.report_date ?? r.report_date
      const time = r.report_date && date === r.report_date ? r.report_time : null
      db.db.prepare("UPDATE records SET kind = CASE WHEN kind = 'other' THEN ? ELSE kind END, title = CASE WHEN title = '未命名报告' THEN ? ELSE title END, report_date = ?, report_time = ? WHERE id = ?").run(r.kind, r.title, date, time, recordId)
      const ins = db.db.prepare(`INSERT INTO labs (id, patient_id, record_id, test_key, test_name, value_num, value_text, unit, ref_low, ref_high, ref_text, flag, collected_on, collected_at, status, source, locator, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'extracted', ?, ?, ?)`)
      for (const l of r.labs) {
        const parsed = parseValue(l.value)
        const flag = parsed.num === null ? (/[↑]|(?<![A-Za-z])H$/.test(l.value) ? 'H' : /[↓]|(?<![A-Za-z])L$/.test(l.value) ? 'L' : null)
          : l.ref_high !== null && parsed.num > l.ref_high ? 'H' : l.ref_low !== null && parsed.num < l.ref_low ? 'L' : null
        ins.run(rid('lb'), patientId, recordId, testKey(l.test_name), l.test_name, parsed.num, parsed.num === null ? l.value : null, l.unit, l.ref_low, l.ref_high, l.ref_text, flag, date, date && time ? `${date} ${time}` : null,
          JSON.stringify({ page: l.page, verified: l.verified }), userId, now())
      }
      const unverified = r.labs.filter(l => !l.verified).length
      set('done', [r.labs.length ? `提取到 ${r.labs.length} 项化验` : '没有提取到化验项', unverified ? `${unverified} 项在原文里没找到对应数字，请重点核对` : '', date ? '' : '报告上没找到日期，确认时请补填'].filter(Boolean).join('；'))
    } catch (err) {
      set('failed', `自动提取失败：${(err as Error).message.slice(0, 120)}。可以在审核里对照原件逐项添加`)
    }
  }

  /** 审核时对照原件补一项（自动提取漏了，或不能自动提取时）：挂在这份报告上，日期取报告日期，待确认。 */
  addRecordLab(a: Actor, patientId: string, recordId: string, input: Record<string, unknown>): LabRow {
    const { c } = this.requireTeam(a, patientId)
    const rec = c.db.db.prepare("SELECT * FROM records WHERE id = ? AND patient_id = ? AND status = 'pending'").get(recordId, patientId) as RecordRow | undefined
    if (!rec) throw new PatientError('not_found', '没有待确认的这份报告', 404)
    const lab = labInput({ ...input, collected_on: rec.report_date ?? '1900-01-01' })
    const id = rid('lb')
    c.db.db.prepare(`INSERT INTO labs (id, patient_id, record_id, test_key, test_name, value_num, value_text, unit, ref_low, ref_high, ref_text, flag, collected_on, status, source, locator, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)`).run(id, patientId, recordId, testKey(lab.test_name), lab.test_name, lab.value_num, lab.value_text, lab.unit,
      lab.ref_low, lab.ref_high, lab.ref_text, flagOf(lab), rec.report_date, a.via === 'ai' ? 'ai' : 'manual', a.userId, now())
    this.log(c, a, patientId, 'lab_add', lab.test_name)
    return labOf(c.db.db.prepare('SELECT * FROM labs WHERE id = ?').get(id) as Record<string, unknown>)
  }

  /** 确认 / 驳回一份报告：确认时一并确认它的待确认化验（报告没有日期时必须补填）。 */
  resolveRecord(a: Actor, patientId: string, recordId: string, input: { accept: boolean; report_date?: unknown }): void {
    const { c } = this.requireTeam(a, patientId)
    this.noAiReview(a, c, input.accept ? '确认报告' : '驳回报告')
    const rec = c.db.db.prepare('SELECT * FROM records WHERE id = ? AND patient_id = ?').get(recordId, patientId) as RecordRow | undefined
    if (!rec) throw new PatientError('not_found', '报告不存在', 404)
    if (!input.accept) {
      c.db.db.prepare("UPDATE records SET status = 'rejected', confirmed_by = ?, confirmed_at = ? WHERE id = ?").run(a.userId, now(), recordId)
      c.db.db.prepare("UPDATE labs SET status = 'rejected', confirmed_by = ?, confirmed_at = ? WHERE record_id = ? AND status = 'pending'").run(a.userId, now(), recordId)
      this.log(c, a, patientId, 'record_reject', recordId)
      return
    }
    const date = typeof input.report_date === 'string' && DATE.test(input.report_date) ? input.report_date : rec.report_date
    const undated = (c.db.db.prepare("SELECT COUNT(*) AS n FROM labs WHERE record_id = ? AND status = 'pending' AND collected_on IS NULL").get(recordId) as { n: number }).n
    if (!date && undated) throw new PatientError('date_required', '这份报告没有日期，请填写报告上的日期（YYYY-MM-DD）')
    c.db.db.prepare("UPDATE records SET status = 'confirmed', report_date = ?, confirmed_by = ?, confirmed_at = ? WHERE id = ?").run(date, a.userId, now(), recordId)
    c.db.db.prepare("UPDATE labs SET collected_on = COALESCE(collected_on, ?) WHERE record_id = ? AND status = 'pending'").run(date, recordId)
    // 同日同项已有确认值：医生选了「替换」的，旧值标为已被更正；数值完全相同的（同一结果重复出现）去掉这条；其余都保留
    let dups = 0
    for (const l of (c.db.db.prepare("SELECT * FROM labs WHERE record_id = ? AND status = 'pending'").all(recordId) as Array<Record<string, unknown>>).map(labOf)) {
      if (l.replaces) { c.db.db.prepare("UPDATE labs SET status = 'superseded' WHERE id = ? AND patient_id = ? AND status = 'confirmed'").run(l.replaces, patientId); continue }
      const same = this.sameDay(c.db, patientId, l).find(o => o.std_value === l.std_value && o.value_text === l.value_text)
      if (same) { c.db.db.prepare("UPDATE labs SET status = 'rejected', confirmed_by = ?, confirmed_at = ? WHERE id = ?").run(a.userId, now(), l.id); dups++ }
    }
    if (dups) this.log(c, a, patientId, 'lab_duplicate_skip', String(dups))
    c.db.db.prepare("UPDATE labs SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE record_id = ? AND status = 'pending'").run(a.userId, now(), recordId)
    c.db.db.prepare('UPDATE patients SET updated_at = ? WHERE id = ?').run(now(), patientId)
    this.log(c, a, patientId, 'record_confirm', recordId)
  }

  /** 改一条待确认的化验（审核时修正提取错误）。 */
  editLab(a: Actor, patientId: string, labId: string, input: Record<string, unknown>): LabRow {
    const { c } = this.requireTeam(a, patientId)
    const cur = c.db.db.prepare("SELECT * FROM labs WHERE id = ? AND patient_id = ? AND status = 'pending'").get(labId, patientId) as Record<string, unknown> | undefined
    if (!cur) throw new PatientError('not_found', '没有待确认的这条化验', 404)
    const merged = { test_name: cur.test_name, value: cur.value_num ?? cur.value_text, unit: cur.unit, ref_low: cur.ref_low, ref_high: cur.ref_high, ref_text: cur.ref_text, collected_on: cur.collected_on ?? '1900-01-01', ...input }
    const lab = labInput(merged)
    c.db.db.prepare('UPDATE labs SET test_key = ?, test_name = ?, value_num = ?, value_text = ?, unit = ?, ref_low = ?, ref_high = ?, ref_text = ?, flag = ?, collected_on = ? WHERE id = ?')
      .run(testKey(lab.test_name), lab.test_name, lab.value_num, lab.value_text, lab.unit, lab.ref_low, lab.ref_high, lab.ref_text, flagOf(lab), input.collected_on ? lab.collected_on : (cur.collected_on as string | null), labId)
    // 「用这个替换」同日同项的某条已确认值（null 取消）
    if (input.replaces !== undefined) {
      const target = input.replaces === null || input.replaces === '' ? null : String(input.replaces)
      if (target && !this.sameDay(c.db, patientId, labOf(c.db.db.prepare('SELECT * FROM labs WHERE id = ?').get(labId) as Record<string, unknown>)).some(o => o.id === target)) {
        throw new PatientError('bad_replaces', '只能替换同一天、同一项目的已确认化验')
      }
      c.db.db.prepare('UPDATE labs SET replaces = ? WHERE id = ?').run(target, labId)
    }
    this.log(c, a, patientId, 'lab_edit', labId)
    return labOf(c.db.db.prepare('SELECT * FROM labs WHERE id = ?').get(labId) as Record<string, unknown>)
  }

  // —— 关联文档（病例报告、随访小结……）——

  /** 把一份文档关联到患者（只能关联自己的文档；文档仍在作者自己的文档库里）。 */
  linkDoc(a: Actor, patientId: string, docId: string, kind: unknown = 'case_report'): void {
    const { c } = this.requireTeam(a, patientId)
    const doc = this.store.getDoc(docId)
    if (!doc || doc.owner !== a.userId || doc.deleted_at) throw new PatientError('not_found', '文档不存在', 404)
    if (doc.context && (JSON.parse(doc.context) as { kind?: string }).kind === 'study') throw new PatientError('in_study', '这份文档归在一个研究项目里，不能再关联到患者', 409)
    const k = kind === 'followup' || kind === 'discussion' || kind === 'other' ? kind : 'case_report'
    c.db.db.prepare('INSERT OR IGNORE INTO patient_docs (patient_id, doc_id, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(patientId, docId, k, a.userId, now())
    // 属于患者的文档：不出现在文档列表里，打开时显示归属并能回到患者页
    const p = c.db.db.prepare('SELECT code FROM patients WHERE id = ?').get(patientId) as { code: string }
    this.store.setDocContext(docId, { kind: 'patient', patient_id: patientId, code: p.code, doc_kind: k })
    this.log(c, a, patientId, 'doc_link', docId)
  }

  unlinkDoc(a: Actor, patientId: string, docId: string): void {
    const { c } = this.requireTeam(a, patientId)
    const r = c.db.db.prepare('DELETE FROM patient_docs WHERE patient_id = ? AND doc_id = ? AND created_by = ?').run(patientId, docId, a.userId)
    if (Number(r.changes) > 0) this.store.setDocContext(docId, null)
    this.log(c, a, patientId, 'doc_unlink', docId)
  }

  /** 关联的文档（新的在前）；已删除的不列。作者以外的人能看到有这份报告，但只有作者能打开（文档共享是以后的事）。 */
  private documents(c: ReturnType<PatientService['ctx']>, patientId: string, viewer: string) {
    return (c.db.db.prepare('SELECT doc_id, kind, created_by, created_at FROM patient_docs WHERE patient_id = ? ORDER BY created_at DESC').all(patientId) as Array<{ doc_id: string; kind: string; created_by: string; created_at: string }>)
      .flatMap(r => {
        const d = this.store.getDoc(r.doc_id)
        if (!d || d.deleted_at) return []
        return [{ doc_id: r.doc_id, kind: r.kind, title: d.title, author: this.store.getUser(r.created_by)?.display_name ?? r.created_by, linked_at: r.created_at, updated_at: d.updated_at, can_open: d.owner === viewer }]
      })
  }

  /** 报告的文字（自动提取时保存的，已打码：姓名、证件号、电话、住院号等换成占位符）。给 AI 读报告用；人看原件。 */
  recordText(a: Actor, patientId: string, recordId: string): { title: string; kind: string; report_date: string | null; text: string | null } {
    const { c } = this.visible(a, patientId)
    const r = c.db.db.prepare('SELECT title, kind, report_date, text_enc FROM records WHERE id = ? AND patient_id = ?').get(recordId, patientId) as { title: string; kind: string; report_date: string | null; text_enc: string | null } | undefined
    if (!r) throw new PatientError('not_found', '报告不存在', 404)
    const text = this.keys.decryptText(c.tenantId, r.text_enc)
    this.log(c, a, patientId, 'record_read', recordId)
    return { title: r.title, kind: r.kind, report_date: r.report_date, text: text === null ? null : redact(text).slice(0, 20000) }
  }

  // —— AI 提议 ——

  propose(a: Actor, patientId: string, input: { kind?: unknown; payload?: unknown; reason?: unknown }): ProposalRow {
    const { c } = this.visible(a, patientId)
    const kind = input.kind
    if (kind !== 'lab' && kind !== 'tag' && kind !== 'note' && kind !== 'update') throw new PatientError('bad_kind', 'kind 只能是 lab / tag / note / update')
    const payload = (input.payload && typeof input.payload === 'object' ? input.payload : {}) as Record<string, unknown>
    if (kind === 'lab') labInput(payload) // 先校验
    if (kind === 'tag' && (typeof payload.tag !== 'string' || !payload.tag.trim())) throw new PatientError('bad_payload', 'tag 需要 payload.tag')
    if (kind === 'note' && (typeof payload.text !== 'string' || !payload.text.trim())) throw new PatientError('bad_payload', 'note 需要 payload.text')
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 300) : ''
    if (!reason) throw new PatientError('reason_required', '请写明依据（来自哪份报告、哪一页）')
    return this.insertProposal(c, a, patientId, kind, payload, reason)
  }

  private insertProposal(c: ReturnType<PatientService['ctx']>, a: Actor, patientId: string, kind: ProposalRow['kind'], payload: Record<string, unknown>, reason: string): ProposalRow {
    const id = rid('pp')
    c.db.db.prepare('INSERT INTO proposals (id, patient_id, kind, payload, reason, turn_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, patientId, kind, JSON.stringify(payload), reason, a.turnId ?? null, 'pending', a.via === 'ai' ? `ai:${a.userId}` : a.userId, now())
    this.log(c, a, patientId, 'propose', kind)
    return proposalOf(c.db.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as Record<string, unknown>)
  }

  private proposals(a: Actor, patientId: string, c: ReturnType<PatientService['ctx']>): ProposalRow[] {
    return (c.db.db.prepare("SELECT * FROM proposals WHERE patient_id = ? AND status = 'pending' ORDER BY created_at").all(patientId) as Array<Record<string, unknown>>).map(proposalOf)
  }

  /** 诊疗组成员采纳 / 驳回 AI 的提议。采纳化验 → 一条已确认的化验（来源记为 ai）。 */
  resolveProposal(a: Actor, patientId: string, proposalId: string, accept: boolean): void {
    if (a.via === 'ai') throw new PatientError('forbidden', 'AI 不能采纳自己的提议', 403)
    const { c, p } = this.requireTeam(a, patientId)
    const r = c.db.db.prepare("SELECT * FROM proposals WHERE id = ? AND patient_id = ? AND status = 'pending'").get(proposalId, patientId) as Record<string, unknown> | undefined
    if (!r) throw new PatientError('not_found', '没有这条待处理的提议', 404)
    const prop = proposalOf(r)
    if (accept) {
      if (prop.kind === 'lab') {
        const lab = this.addLab({ ...a, via: 'user' }, patientId, prop.payload)
        c.db.db.prepare("UPDATE labs SET source = 'ai' WHERE id = ?").run(lab.id)
      } else if (prop.kind === 'update') {
        this.update(a, patientId, prop.payload)
      } else if (prop.kind === 'enroll' || prop.kind === 'unenroll') {
        // 入组 / 移出只能由研究负责人确认（研究归个人；诊疗组的其他成员看得到提议，但不能替别人的研究做决定）
        const study = this.store.getStudy(String(prop.payload.study_id))
        if (!study || study.owner !== a.userId) throw new PatientError('forbidden', '只有研究负责人能确认入组 / 移出', 403)
        if (prop.kind === 'enroll') this.enrollOne(c, a, patientId, study.id, typeof prop.payload.criteria === 'string' ? prop.payload.criteria : null)
        else this.withdrawOne(c, a, patientId, study.id)
      } else if (prop.kind === 'tag') {
        this.update(a, patientId, { tags: [...new Set([...p.tags, String(prop.payload.tag).trim()])] })
      } else {
        const cur = this.keys.decryptText(c.tenantId, (c.db.db.prepare('SELECT summary_enc FROM patients WHERE id = ?').get(patientId) as { summary_enc: string | null }).summary_enc) ?? ''
        this.update(a, patientId, { summary: (cur ? cur + '\n' : '') + String(prop.payload.text).trim() })
      }
    }
    c.db.db.prepare('UPDATE proposals SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?').run(accept ? 'accepted' : 'rejected', a.userId, now(), proposalId)
    this.log(c, a, patientId, accept ? 'proposal_accept' : 'proposal_reject', proposalId)
  }

  // —— 研究入组（docs/design/COHORT.md）——
  // 研究归个人（平台库），入组关系与研究编号在机构患者库。调用方（research/cohort.ts）先确认研究属于操作者。
  // 只有诊疗组成员（负责人 / 成员）能把患者入组：机构全员可见、紧急访问都不行。

  /** 机构是否允许 AI 用患者数据（含由患者生成的研究数据集）；不允许时抛错。 */
  assertAi(a: Actor): void { this.ctx(a) }

  /** 按条件筛选「我在诊疗组里的」在管患者。只返回代号与匹配依据；命中的患者各记一条访问日志。 */
  screen(a: Actor, studyId: string, criteria: unknown): { criteria: Criteria; total: number; patients: Array<{ patient_id: string; code: string; sex: string | null; age: number | null; tags: string[]; matched: string[]; subject_id: string | null }> } {
    const c = this.ctx(a)
    const cr = parseCriteria(criteria)
    const rows = (c.db.db.prepare("SELECT p.* FROM patients p JOIN care_team t ON t.patient_id = p.id AND t.user_id = ? WHERE p.status = 'active' ORDER BY p.code").all(a.userId) as Array<Record<string, unknown>>).map(patientOf)
    const year = new Date().getUTCFullYear()
    const out = []
    for (const p of rows) {
      const labs = (c.db.db.prepare("SELECT * FROM labs WHERE patient_id = ? AND status = 'confirmed' ORDER BY collected_on, COALESCE(collected_at, collected_on), created_at").all(p.id) as Array<Record<string, unknown>>).map(labOf)
      const m = matchCriteria(cr, p, labs, year)
      if (!m) continue
      const enrolled = c.db.db.prepare("SELECT subject_id FROM enrollments WHERE study_id = ? AND patient_id = ? AND status = 'active'").get(studyId, p.id) as { subject_id: string } | undefined
      out.push({ patient_id: p.id, code: p.code, sex: p.sex, age: p.birth_year ? year - p.birth_year : null, tags: p.tags, matched: m, subject_id: enrolled?.subject_id ?? null })
      this.log(c, a, p.id, 'cohort_screen', `研究 ${studyId}`)
    }
    return { criteria: cr, total: out.length, patients: out }
  }

  /**
   * 入组。人：直接生效；AI：机构设为需医生确认（review）时每位患者一条「入组」提议，由研究负责人在患者页或研究页确认。
   * 已入组的跳过；之前移出过的恢复原研究编号。
   */
  enroll(a: Actor, studyId: string, patientIds: string[], criteria: unknown = null): { enrolled: Array<{ patient_id: string; subject_id: string }>; proposed: string[]; skipped: Array<{ patient_id: string; reason: string }> } {
    const res = { enrolled: [] as Array<{ patient_id: string; subject_id: string }>, proposed: [] as string[], skipped: [] as Array<{ patient_id: string; reason: string }> }
    const crit = criteria ? JSON.stringify(parseCriteria(criteria)) : null
    for (const pid of [...new Set(patientIds)].slice(0, 500)) {
      let c: ReturnType<PatientService['ctx']>
      try { c = this.requireTeam(a, pid).c } catch (err) {
        if (err instanceof PatientError && (err.code === 'not_found' || err.code === 'forbidden')) { res.skipped.push({ patient_id: pid, reason: err.code === 'forbidden' ? '不在诊疗组里，不能入组' : '患者不存在' }); continue }
        throw err
      }
      const cur = c.db.db.prepare('SELECT subject_id, status FROM enrollments WHERE study_id = ? AND patient_id = ?').get(studyId, pid) as { subject_id: string; status: string } | undefined
      if (cur?.status === 'active') { res.skipped.push({ patient_id: pid, reason: `已入组（${cur.subject_id}）` }); continue }
      if (this.aiReview(a, c)) {
        if (c.db.db.prepare("SELECT 1 FROM proposals WHERE patient_id = ? AND kind = 'enroll' AND status = 'pending' AND json_extract(payload, '$.study_id') = ?").get(pid, studyId)) { res.skipped.push({ patient_id: pid, reason: '已有待确认的入组提议' }); continue }
        const title = this.store.getStudy(studyId)?.title ?? ''
        this.insertProposal(c, a, pid, 'enroll', { study_id: studyId, study_title: title, criteria: crit }, `AI 建议入组研究「${title}」`)
        res.proposed.push(pid)
        continue
      }
      res.enrolled.push({ patient_id: pid, subject_id: this.enrollOne(c, a, pid, studyId, crit) })
    }
    return res
  }

  private enrollOne(c: ReturnType<PatientService['ctx']>, a: Actor, patientId: string, studyId: string, criteria: string | null): string {
    const cur = c.db.db.prepare('SELECT subject_id, status FROM enrollments WHERE study_id = ? AND patient_id = ?').get(studyId, patientId) as { subject_id: string; status: string } | undefined
    if (cur?.status === 'active') return cur.subject_id
    const subject = cur?.subject_id ?? c.db.nextSubject(studyId)
    c.db.db.prepare(`INSERT INTO enrollments (study_id, patient_id, subject_id, status, criteria, enrolled_by, enrolled_at) VALUES (?, ?, ?, 'active', ?, ?, ?)
      ON CONFLICT(study_id, patient_id) DO UPDATE SET status = 'active', criteria = excluded.criteria, enrolled_by = excluded.enrolled_by, enrolled_at = excluded.enrolled_at, withdrawn_at = NULL`)
      .run(studyId, patientId, subject, criteria, a.userId, now())
    this.log(c, a, patientId, 'enroll', `研究 ${studyId} · ${subject}`)
    return subject
  }

  /** 移出研究（研究编号保留不复用；之后再入组恢复同一编号）。AI 在 review 模式下变成一条「移出」提议。 */
  unenroll(a: Actor, studyId: string, patientId: string): { result: 'withdrawn' | 'proposed' } {
    const c = this.ctx(a)
    const cur = c.db.db.prepare("SELECT subject_id FROM enrollments WHERE study_id = ? AND patient_id = ? AND status = 'active'").get(studyId, patientId) as { subject_id: string } | undefined
    if (!cur) throw new PatientError('not_found', '这位患者不在这个研究里', 404)
    if (this.aiReview(a, c)) {
      this.visible(a, patientId)
      this.insertProposal(c, a, patientId, 'unenroll', { study_id: studyId, study_title: this.store.getStudy(studyId)?.title ?? '', subject_id: cur.subject_id }, `AI 建议把 ${cur.subject_id} 移出研究`)
      return { result: 'proposed' }
    }
    this.withdrawOne(c, a, patientId, studyId)
    return { result: 'withdrawn' }
  }

  private withdrawOne(c: ReturnType<PatientService['ctx']>, a: Actor, patientId: string, studyId: string): void {
    const r = c.db.db.prepare("UPDATE enrollments SET status = 'withdrawn', withdrawn_at = ? WHERE study_id = ? AND patient_id = ? AND status = 'active'").run(now(), studyId, patientId)
    if (Number(r.changes)) this.log(c, a, patientId, 'unenroll', `研究 ${studyId}`)
  }

  /** 研究的入组名单（按研究编号）。代号只在操作者仍能看到这位患者时给出。另附待确认的入组 / 移出提议。 */
  enrollments(a: Actor, studyId: string): { subjects: Array<{ subject_id: string; patient_id: string; code: string | null; sex: string | null; age_at_enroll: number | null; tags: string[]; enrolled_at: string; status: string; withdrawn_at: string | null }>; pending: Array<{ proposal_id: string; patient_id: string; code: string | null; kind: string; reason: string; created_at: string }> } {
    const c = this.ctx(a)
    const rows = c.db.db.prepare('SELECT e.*, p.code, p.sex, p.birth_year, p.tags FROM enrollments e JOIN patients p ON p.id = e.patient_id WHERE e.study_id = ? ORDER BY e.subject_id').all(studyId) as Array<Record<string, unknown>>
    const canSee = (pid: string) => { try { this.visible(a, pid); return true } catch { return false } }
    const subjects = rows.map(r => ({
      subject_id: r.subject_id as string, patient_id: r.patient_id as string, code: canSee(r.patient_id as string) ? r.code as string : null, sex: (r.sex as string | null) ?? null,
      age_at_enroll: r.birth_year ? Number(String(r.enrolled_at).slice(0, 4)) - Number(r.birth_year) : null, tags: JSON.parse((r.tags as string) || '[]') as string[],
      enrolled_at: r.enrolled_at as string, status: r.status as string, withdrawn_at: (r.withdrawn_at as string | null) ?? null,
    }))
    const pending = (c.db.db.prepare("SELECT pr.*, p.code FROM proposals pr JOIN patients p ON p.id = pr.patient_id WHERE pr.status = 'pending' AND pr.kind IN ('enroll', 'unenroll') AND json_extract(pr.payload, '$.study_id') = ? ORDER BY pr.created_at").all(studyId) as Array<Record<string, unknown>>)
      .filter(r => canSee(r.patient_id as string))
      .map(r => ({ proposal_id: r.id as string, patient_id: r.patient_id as string, code: r.code as string, kind: r.kind as string, reason: r.reason as string, created_at: r.created_at as string }))
    return { subjects, pending }
  }

  /** 患者所在的研究（患者页概况显示）。 */
  private studiesOf(c: ReturnType<PatientService['ctx']>, patientId: string): Array<{ study_id: string; title: string; subject_id: string; enrolled_at: string }> {
    return (c.db.db.prepare("SELECT study_id, subject_id, enrolled_at FROM enrollments WHERE patient_id = ? AND status = 'active' ORDER BY enrolled_at").all(patientId) as Array<{ study_id: string; subject_id: string; enrolled_at: string }>)
      .flatMap(e => { const s = this.store.getStudy(e.study_id); return s ? [{ ...e, title: s.title }] : [] })
  }

  /**
   * 研究数据集的快照：入组中的受试者（研究编号、性别、入组时年龄、标签）与所选化验项目的已确认值（标准单位）。
   * 只含操作者仍在诊疗组里的受试者（其余列在 skipped）。fingerprint 随入组名单、受试者信息、相关化验的变化而变（判断数据集是否过期）。
   * log=true 时每位受试者记一条访问日志（生成数据集时）。
   */
  cohortSnapshot(a: Actor, studyId: string, opts: { tests?: string[]; from?: string | null; to?: string | null; log?: boolean } = {}) {
    const c = this.ctx(a)
    const rows = c.db.db.prepare("SELECT e.subject_id, e.enrolled_at, p.* FROM enrollments e JOIN patients p ON p.id = e.patient_id WHERE e.study_id = ? AND e.status = 'active' ORDER BY e.subject_id").all(studyId) as Array<Record<string, unknown>>
    const keys = opts.tests?.length ? new Set(opts.tests.map(testKey)) : null
    const subjects: Array<{ subject_id: string; sex: string | null; age_at_enroll: number | null; tags: string[]; enrolled_on: string; labs: LabRow[] }> = []
    const skipped: string[] = []
    const fp = createHash('sha256')
    for (const r of rows) {
      const pid = r.id as string
      if (!this.teamRole(c.db, pid, a.userId)) { skipped.push(r.subject_id as string); continue }
      const where = ["patient_id = ?", "status = 'confirmed'"]
      const args: string[] = [pid]
      if (opts.from && DATE.test(opts.from)) { where.push('collected_on >= ?'); args.push(opts.from) }
      if (opts.to && DATE.test(opts.to)) { where.push('collected_on <= ?'); args.push(opts.to) }
      let labs = (c.db.db.prepare(`SELECT * FROM labs WHERE ${where.join(' AND ')} ORDER BY test_key, collected_on, COALESCE(collected_at, collected_on), created_at`).all(...args) as Array<Record<string, unknown>>).map(labOf)
      if (keys) labs = labs.filter(l => keys.has(l.test_key))
      const p = patientOf(r)
      const s = { subject_id: r.subject_id as string, sex: p.sex, age_at_enroll: p.birth_year ? Number(String(r.enrolled_at).slice(0, 4)) - p.birth_year : null, tags: p.tags, enrolled_on: String(r.enrolled_at).slice(0, 10), labs }
      subjects.push(s)
      fp.update(JSON.stringify([s.subject_id, s.sex, p.birth_year, s.tags, labs.map(l => [l.id, l.value_num, l.unit, l.collected_on])]))
      if (opts.log) this.log(c, a, pid, 'cohort_export', `研究 ${studyId} · ${s.subject_id}`)
    }
    fp.update(JSON.stringify(skipped))
    return { subjects, skipped, fingerprint: fp.digest('hex').slice(0, 24) }
  }

  /** 研究删除时清掉入组关系与待确认的入组提议（研究编号随研究一起作废）。 */
  dropStudy(a: Actor, studyId: string): void {
    let c: ReturnType<PatientService['ctx']>
    try { c = this.ctx(a) } catch { return }
    for (const r of c.db.db.prepare("SELECT patient_id FROM enrollments WHERE study_id = ? AND status = 'active'").all(studyId) as Array<{ patient_id: string }>) this.log(c, a, r.patient_id, 'unenroll', `研究 ${studyId} 已删除`)
    c.db.db.prepare('DELETE FROM enrollments WHERE study_id = ?').run(studyId)
    c.db.db.prepare("UPDATE proposals SET status = 'rejected', resolved_by = ?, resolved_at = ? WHERE status = 'pending' AND kind IN ('enroll', 'unenroll') AND json_extract(payload, '$.study_id') = ?").run(a.userId, now(), studyId)
    c.db.db.prepare('DELETE FROM seq WHERE name = ?').run(`subject:${studyId}`)
  }

  /** 关掉所有库连接（测试 / 停机）。 */
  close(): void { for (const d of this.dbs.values()) d.close(); this.dbs.clear() }
}

// —— 输入校验 ——

function sex(v: unknown): 'M' | 'F' | null {
  return v === 'M' || v === 'F' ? v : v === '男' ? 'M' : v === '女' ? 'F' : null
}
function birthYear(v: unknown): number | null {
  const n = Number(v)
  if (v === null || v === undefined || v === '') return null
  if (!Number.isInteger(n) || n < 1900 || n > new Date().getFullYear()) throw new PatientError('bad_birth_year', '出生年份不对')
  return n
}
function tags(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter((x): x is string => typeof x === 'string').map(x => x.trim().slice(0, 40)).filter(Boolean))].slice(0, 20)
}
function labInput(v: Record<string, unknown>) {
  const name = typeof v.test_name === 'string' ? v.test_name.trim().slice(0, 60) : ''
  if (!name) throw new PatientError('bad_lab', '化验项目名不能为空')
  const date = typeof v.collected_on === 'string' ? v.collected_on.trim() : ''
  if (!DATE.test(date)) throw new PatientError('bad_lab', '化验日期要写成 YYYY-MM-DD（报告上的日期）')
  const num = (x: unknown) => x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x)
  const value_num = num(v.value)
  const value_text = value_num === null && typeof v.value === 'string' && v.value.trim() ? v.value.trim().slice(0, 60) : (typeof v.value_text === 'string' ? v.value_text.slice(0, 60) : null)
  if (value_num === null && !value_text) throw new PatientError('bad_lab', '化验值不能为空')
  const locator = v.locator && typeof v.locator === 'object' ? v.locator as LabRow['locator'] : null
  return {
    test_name: name, value_num, value_text, unit: typeof v.unit === 'string' ? v.unit.trim().slice(0, 20) || null : null,
    ref_low: num(v.ref_low), ref_high: num(v.ref_high), ref_text: typeof v.ref_text === 'string' ? v.ref_text.slice(0, 60) : null, collected_on: date, locator,
  }
}
/** 报告上的数值：「141」「141↑」「141 H」→ 数值 141；「<0.5」「阴性」→ 文字。 */
function parseValue(v: string): { num: number | null } {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(?:[↑↓]|[HL](?![A-Za-z]))?\s*$/.exec(v)
  return { num: m ? Number(m[1]) : null }
}

function flagOf(l: ReturnType<typeof labInput>): 'H' | 'L' | null {
  if (l.value_num === null) return null
  if (l.ref_high !== null && l.value_num > l.ref_high) return 'H'
  if (l.ref_low !== null && l.value_num < l.ref_low) return 'L'
  return null
}

// —— 入组筛选条件 ——

export type LabOp = '>' | '>=' | '<' | '<=' | '='
export interface LabCriterion { test: string; test_key: string; mode: 'latest' | 'any'; op: LabOp; value: number }
export interface Criteria {
  sex: 'M' | 'F' | null; age_min: number | null; age_max: number | null
  /** 诊断标签包含其中任一（不分大小写、部分匹配） */
  tags_any: string[]
  /** 化验条件（都要满足）；用换算到标准单位后的已确认值 */
  labs: LabCriterion[]
  /** 报告日期窗口：只看这段时间内的化验；只给窗口时要求窗口内至少有一次化验 */
  from: string | null; to: string | null
}

const OPS: LabOp[] = ['>', '>=', '<', '<=', '=']
export function parseCriteria(v: unknown): Criteria {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : null
  const date = (x: unknown) => typeof x === 'string' && DATE.test(x) ? x : null
  const labs = (Array.isArray(o.labs) ? o.labs : []).slice(0, 10).map(x => {
    const l = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    const test = typeof l.test === 'string' ? l.test.trim() : ''
    const op = OPS.includes(l.op as LabOp) ? l.op as LabOp : null
    const value = num(l.value)
    if (!test || !op || value === null) throw new PatientError('bad_criteria', '化验条件要有项目、比较符（> >= < <= =）和数值')
    return { test, test_key: testKey(test), mode: l.mode === 'any' ? 'any' as const : 'latest' as const, op, value }
  })
  return {
    sex: o.sex === 'M' || o.sex === 'F' ? o.sex : null, age_min: num(o.age_min), age_max: num(o.age_max),
    tags_any: (Array.isArray(o.tags_any) ? o.tags_any : []).filter((t): t is string => typeof t === 'string' && t.trim() !== '').map(t => t.trim()).slice(0, 20),
    labs, from: date(o.from), to: date(o.to),
  }
}

const cmp = (a: number, op: LabOp, b: number) => op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : op === '<=' ? a <= b : Math.abs(a - b) < 1e-9

/** 符合条件时返回匹配依据（给医生核对），不符合返回 null。labs：这位患者的已确认化验（按日期升序）。 */
export function matchCriteria(cr: Criteria, p: PatientRow, labs: LabRow[], year: number): string[] | null {
  const why: string[] = []
  if (cr.sex) { if (p.sex !== cr.sex) return null; why.push(cr.sex === 'M' ? '男' : '女') }
  if (cr.age_min !== null || cr.age_max !== null) {
    if (!p.birth_year) return null
    const age = year - p.birth_year
    if ((cr.age_min !== null && age < cr.age_min) || (cr.age_max !== null && age > cr.age_max)) return null
    why.push(`${age} 岁`)
  }
  if (cr.tags_any.length) {
    const hit = p.tags.find(t => cr.tags_any.some(q => t.toLowerCase().includes(q.toLowerCase())))
    if (!hit) return null
    why.push(`标签「${hit}」`)
  }
  const inWin = labs.filter(l => l.collected_on && (!cr.from || l.collected_on >= cr.from) && (!cr.to || l.collected_on <= cr.to))
  if ((cr.from || cr.to) && !cr.labs.length) {
    if (!inWin.length) return null
    why.push(`窗口内 ${inWin.length} 次化验`)
  }
  for (const q of cr.labs) {
    const vals = inWin.filter(l => l.test_key === q.test_key && l.std_value !== null)
    if (!vals.length) return null
    const pick = q.mode === 'latest' ? [vals[vals.length - 1]!] : vals
    const hit = pick.find(l => cmp(l.std_value!, q.op, q.value))
    if (!hit) return null
    why.push(`${hit.test_name} ${hit.std_value}${hit.std_unit ? ' ' + hit.std_unit : ''}（${hit.collected_on}${q.mode === 'latest' ? '，最近一次' : ''}）`)
  }
  return why
}
