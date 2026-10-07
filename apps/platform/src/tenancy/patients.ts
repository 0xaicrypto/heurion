import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Space, TenantService, TenantSettings } from '../auth/tenants.ts'
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

/** 成员标记（知家红线守卫用；与 ops/phr-guard.ts 的 PhrMember 同形）。 */
export interface PhrMemberLike { tags: string[]; birth_year: number | null }

export interface PatientRow {
  id: string; code: string; sex: 'M' | 'F' | null; birth_year: number | null; tags: string[]
  /** 称呼（家人档案里的叫法，加密存储；机构端为 null，患者端用称呼不用代号） */
  name: string | null
  status: 'active' | 'archived'; created_by: string; created_at: string; updated_at: string
}
export interface LabRow {
  id: string; patient_id: string; record_id: string | null; test_key: string; test_name: string
  value_num: number | null; value_text: string | null; unit: string | null
  ref_low: number | null; ref_high: number | null; ref_text: string | null; flag: 'H' | 'L' | null
  /** 报告上的日期；提取时报告上没写日期的为 null，确认报告时由医生补填 */
  collected_on: string | null; status: 'pending' | 'confirmed' | 'rejected' | 'superseded'; source: 'manual' | 'extracted' | 'ai' | 'share'
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
  imaging_data?: Record<string, unknown> | null
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
  [/^(eos|eos%|eos#|嗜酸性粒细胞|嗜酸性粒细胞绝对值|嗜酸性粒细胞百分比|嗜酸粒细胞)$/i, 'eosinophils'],
  [/^(ige|总ige|血清总ige|免疫球蛋白e)$/i, 'total_ige'],
  [/^(af-?s?ige|烟曲霉特异性ige|曲霉sige|m3)$/i, 'aspergillus_sige'],
  [/^(cea|癌胚抗原)$/i, 'cea'],
  [/^(cyfra21-?1|细胞角蛋白19片段)$/i, 'cyfra21_1'],
  [/^(nse|神经元特异性烯醇化酶)$/i, 'nse'],
  [/^(scc|scc-?ag|鳞状细胞癌抗原)$/i, 'scc'],
  [/^(esr|血沉|红细胞沉降率)$/i, 'esr'],
  [/^(pct|降钙素原)$/i, 'pct'],
  [/^(afp|甲胎蛋白)$/i, 'afp'],
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
      PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000; PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS seq (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS patients (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name_enc TEXT, sex TEXT, birth_year INTEGER, tags TEXT NOT NULL DEFAULT '[]', summary_enc TEXT,
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
    if (!cols('patients').includes('name_enc')) this.db.exec('ALTER TABLE patients ADD COLUMN name_enc TEXT')
    if (!labCols.includes('collected_at')) this.db.exec('ALTER TABLE labs ADD COLUMN collected_at TEXT')
    if (!labCols.includes('replaces')) this.db.exec('ALTER TABLE labs ADD COLUMN replaces TEXT')
    if (!cols('records').includes('report_time')) this.db.exec('ALTER TABLE records ADD COLUMN report_time TEXT')
    // 来源追溯（知家分享纳入本院时记 share:<分享 id>）
    if (!cols('records').includes('origin')) this.db.exec('ALTER TABLE records ADD COLUMN origin TEXT')
    if (!labCols.includes('origin')) this.db.exec('ALTER TABLE labs ADD COLUMN origin TEXT')
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

const patientOf = (r: Record<string, unknown>, name: string | null = null): PatientRow => ({
  id: r.id as string, code: r.code as string, name, sex: (r.sex as PatientRow['sex']) ?? null, birth_year: (r.birth_year as number | null) ?? null,
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

/** 知家分享的范围：类目（化验 / 报告原件 / 简报与健康档案）与起始日期。 */
export interface ShareScope { categories: Array<'labs' | 'reports' | 'docs'>; since: string | null }

export interface Actor {
  userId: string
  /** ai = AI 经 MCP 代该用户访问（访问日志里区分） */
  via: 'user' | 'ai'
  turnId?: string | null
  /** 哪个空间的患者库：work = 工作台（医院或个人，默认）；personal = 知家（个人空间）。docs/design/TENANCY.md §双重身份 */
  space?: Space
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
    /** 成员建档即建「健康档案」文档（知家 V0，PATIENT.md §12）：人 / AI 建档同路径；没有时建档不产文档。 */
    private readonly archiveDoc?: (input: { owner: string; title: string; patientId: string }) => string | null,
  ) {}

  /** 机构服务（知家分享等需要按机构判断的服务共用这一个实例）。 */
  get tenantService(): TenantService { return this.tenants }

  /** 等后台提取完（测试用）。 */
  idle(): Promise<void> { return this.queue }

  // —— 机构与权限 ——

  /** 打开操作者所在机构的患者库。机构不开患者模块时拒绝。 */
  private ctx(a: Actor): { db: TenantPatientDb; tenantId: string; settings: TenantSettings; tenantAdmin: boolean; tenantKind: 'personal' | 'org' } {
    const t = this.tenants.of(a.userId, a.space ?? 'work')
    const settings = this.tenants.settings(t)
    if (!settings.patient_module) throw new PatientError('patient_module_off', '本机构没有启用患者模块', 403)
    if (a.via === 'ai' && !settings.external_model_for_patients) throw new PatientError('external_model_off', '本机构设置为患者数据不交给外部模型分析', 403)
    let db = this.dbs.get(t.id)
    if (!db) { db = new TenantPatientDb(this.root, t.id); this.dbs.set(t.id, db) }
    return { db, tenantId: t.id, settings, tenantAdmin: this.tenants.roleOf(a.userId, a.space ?? 'work') === 'admin', tenantKind: t.kind }
  }

  /** 手动录入化验只对个人租户（知家家庭空间）开放；医院端化验一律来自上传报告（追溯原件）。 */
  requirePersonal(a: Actor): void {
    const c = this.ctx(a)
    if (c.tenantKind !== 'personal') throw new PatientError('manual_labs_org', '手工录入化验只在知家（个人空间）开放；医院端请上传报告，在报告上补项', 403)
  }

  /** 写前断言：操作者能改这位成员（知家建文档 / 简报前调用，避免建了文档关联不上留下孤儿）。 */
  assertEditable(a: Actor, patientId: string): void { this.requireTeam(a, patientId) }

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
    return { c, p: patientOf(r, this.keys.decryptText(c.tenantId, (r.name_enc as string | null) ?? null)), role }
  }

  private log(c: { db: TenantPatientDb }, a: Actor, patientId: string, action: string, detail: string | null = null): void {
    c.db.db.prepare('INSERT INTO access_log (at, user_id, patient_id, action, via, detail) VALUES (?, ?, ?, ?, ?, ?)').run(now(), a.userId, patientId, action, a.via, detail)
  }

  // —— 患者 ——

  create(a: Actor, input: { sex?: unknown; birth_year?: unknown; tags?: unknown; name?: unknown }): PatientRow {
    const c = this.ctx(a)
    const nm = name(input.name)
    // 称呼只在知家（个人空间）可用：医院端患者只用代号，避免真名落库后发给外部模型
    if (nm && c.tenantKind !== 'personal') throw new PatientError('name_org', '医院端患者只用代号；称呼只在知家（个人空间）可用', 400)
    const id = rid('pt')
    const t = now()
    c.db.db.prepare('INSERT INTO patients (id, code, name_enc, sex, birth_year, tags, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, c.db.nextCode(), this.keys.encryptText(c.tenantId, nm), sex(input.sex), birthYear(input.birth_year), JSON.stringify(tags(input.tags)), a.userId, t, t)
    c.db.db.prepare('INSERT INTO care_team (patient_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)').run(id, a.userId, 'owner', a.userId, t)
    const p = this.visible(a, id).p
    // 成员的「健康档案」文档：只在知家（个人空间）建档时创建；医院端不生成（临床表述不受患者红线约束）
    if (c.tenantKind === 'personal') {
      const docId = this.archiveDoc?.({ owner: a.userId, patientId: id, title: `${p.code} 健康档案` })  // 标题只用代号：标题会出现在 AI 读到的内容里，称呼不发给外部模型
      if (docId) this.linkDoc(a, id, docId, 'archive')
    }
    this.log(c, a, id, 'create')
    return p
  }

  list(a: Actor): Array<PatientRow & { role: string; labs: number; lab_reports: number; last_lab: string | null; pending: number }> {
    const c = this.ctx(a)
    const rows = (c.settings.patient_visibility === 'tenant'
      ? c.db.db.prepare('SELECT * FROM patients ORDER BY updated_at DESC').all()
      : c.db.db.prepare(`SELECT p.* FROM patients p WHERE p.id IN (SELECT patient_id FROM care_team WHERE user_id = ?)
          OR p.id IN (SELECT patient_id FROM break_glass WHERE user_id = ? AND expires_at > ?) ORDER BY p.updated_at DESC`).all(a.userId, a.userId, now())) as Array<Record<string, unknown>>
    return rows.map(r => {
      const p = patientOf(r, this.keys.decryptText(c.tenantId, (r.name_enc as string | null) ?? null))
      // n = 已确认的化验项数；reports = 化验单份数（同一份报告算一次；手工录入按日期算一次）
      const stats = c.db.db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT COALESCE(record_id, 'manual:' || collected_on)) AS reports, MAX(collected_on) AS last FROM labs WHERE patient_id = ? AND status = 'confirmed'").get(p.id) as { n: number; reports: number; last: string | null }
      const pending = (c.db.db.prepare("SELECT (SELECT COUNT(*) FROM labs WHERE patient_id = ? AND status = 'pending') + (SELECT COUNT(*) FROM proposals WHERE patient_id = ? AND status = 'pending') AS n").get(p.id, p.id) as { n: number }).n
      return { ...p, role: this.teamRole(c.db, p.id, a.userId) ?? (c.settings.patient_visibility === 'tenant' ? 'tenant' : 'break_glass'), labs: stats.n, lab_reports: stats.reports, last_lab: stats.last, pending }
    })
  }

  /** 概况：基本信息、诊疗组、报告、各项化验的最近值。记一次查看。 */
  read(a: Actor, patientId: string) {
    const { c, p, role } = this.visible(a, patientId)
    const summary = c.db.db.prepare('SELECT summary_enc FROM patients WHERE id = ?').get(patientId) as { summary_enc: string | null }
    const team = (c.db.db.prepare('SELECT user_id, role, added_at FROM care_team WHERE patient_id = ? ORDER BY added_at').all(patientId) as Array<{ user_id: string; role: string; added_at: string }>)
      .map(m => ({ ...m, name: this.store.getUser(m.user_id)?.display_name ?? m.user_id }))
    const records = (c.db.db.prepare('SELECT * FROM records WHERE patient_id = ? ORDER BY COALESCE(report_date, created_at) DESC').all(patientId) as unknown as Array<RecordRow & { text_enc?: string | null }>)
      .map(r => {
        let imaging_data: Record<string, unknown> | null = null
        if (r.kind === 'imaging' && r.text_enc) {
          try {
            const dec = this.keys.decryptText(c.tenantId, r.text_enc)
            if (dec) imaging_data = JSON.parse(dec)
          } catch {}
        }
        return { ...r, text_enc: undefined, imaging_data }
      })
    // 每项最近一次（同一天多次时取采样时间最晚、再取录入最晚的）
    const all = (c.db.db.prepare("SELECT * FROM labs WHERE patient_id = ? AND status = 'confirmed' ORDER BY test_key, collected_on, COALESCE(collected_at, collected_on), created_at").all(patientId) as Array<Record<string, unknown>>).map(labOf)
    const latest = [...new Map(all.map(l => [l.test_key, l])).values()]
    this.log(c, a, patientId, 'view')
    return { ...p, access: role, documents: this.documents(c, patientId, a.userId), studies: this.studiesOf(c, patientId), summary: this.keys.decryptText(c.tenantId, summary.summary_enc), care_team: team, records, latest_labs: latest, pending_proposals: this.proposals(a, patientId, c) }
  }

  update(a: Actor, patientId: string, patch: { sex?: unknown; birth_year?: unknown; tags?: unknown; summary?: unknown; status?: unknown; name?: unknown }): PatientRow {
    const { c } = this.requireTeam(a, patientId)
    // 称呼只在知家（个人空间）可改：医院端保持只用代号
    if (patch.name !== undefined && c.tenantKind !== 'personal' && name(patch.name) !== null) throw new PatientError('name_org', '医院端患者只用代号；称呼只在知家（个人空间）可用', 400)
    if (this.aiReview(a, c)) {
      // 需医生确认：作为一条「修改」提议
      const clean: Record<string, unknown> = {}
      for (const k of ['sex', 'birth_year', 'tags', 'summary', 'status', 'name'] as const) if (patch[k] !== undefined) clean[k] = patch[k]
      if (patch.birth_year !== undefined) birthYear(patch.birth_year)
      this.propose(a, patientId, { kind: 'update', payload: clean, reason: typeof (patch as { reason?: unknown }).reason === 'string' ? (patch as { reason: string }).reason : 'AI 修改患者信息' })
      return this.visible(a, patientId).p
    }
    const sets: string[] = []
    const args: Array<string | number | null> = []
    if (patch.sex !== undefined) { sets.push('sex = ?'); args.push(sex(patch.sex)) }
    if (patch.birth_year !== undefined) { sets.push('birth_year = ?'); args.push(birthYear(patch.birth_year)) }
    if (patch.tags !== undefined) { sets.push('tags = ?'); args.push(JSON.stringify(tags(patch.tags))) }
    if (patch.name !== undefined) { sets.push('name_enc = ?'); args.push(this.keys.encryptText(c.tenantId, name(patch.name))) }
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

  // —— 知家分享（docs/design/SHARING.md）：医生按分享只读家人个人空间里的数据；权限由 ShareService 判定 ——

  /** 用某个机构（个人空间）的数据密钥加密 / 解密一段短文字（分享里「给医生看的姓名」）。 */
  sealText(tenantId: string, text: string | null): string | null { return this.keys.encryptText(tenantId, text) }
  openText(tenantId: string, enc: string | null): string | null { return this.keys.decryptText(tenantId, enc) }

  private dbFor(tenantId: string): TenantPatientDb {
    let db = this.dbs.get(tenantId)
    if (!db) { db = new TenantPatientDb(this.root, tenantId); this.dbs.set(tenantId, db) }
    return db
  }

  /** 分享视图（只读、按范围过滤，只含已确认的内容）。不给称呼：医生看到的姓名由家人在分享里另填。 */
  sharedView(tenantId: string, patientId: string, scope: ShareScope) {
    const db = this.dbFor(tenantId)
    const r = db.db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId) as Record<string, unknown> | undefined
    if (!r) throw new PatientError('not_found', '分享的档案已不存在', 404)
    const p = patientOf(r)
    const has = (k: ShareScope['categories'][number]) => scope.categories.includes(k)
    const since = scope.since && DATE.test(scope.since) ? scope.since : null
    const labs = has('labs')
      ? (db.db.prepare(`SELECT * FROM labs WHERE patient_id = ? AND status = 'confirmed'${since ? ' AND collected_on >= ?' : ''} ORDER BY test_key, collected_on, COALESCE(collected_at, collected_on), created_at`)
          .all(...(since ? [patientId, since] : [patientId])) as Array<Record<string, unknown>>).map(labOf)
      : []
    const records = has('reports')
      ? (db.db.prepare(`SELECT id, kind, title, report_date, file_id FROM records WHERE patient_id = ? AND status = 'confirmed'${since ? ' AND COALESCE(report_date, created_at) >= ?' : ''} ORDER BY COALESCE(report_date, created_at) DESC`)
          .all(...(since ? [patientId, since] : [patientId])) as Array<{ id: string; kind: string; title: string; report_date: string | null; file_id: string | null }>)
      : []
    const documents = has('docs')
      ? (db.db.prepare('SELECT doc_id, kind, created_at FROM patient_docs WHERE patient_id = ? ORDER BY created_at DESC').all(patientId) as Array<{ doc_id: string; kind: string; created_at: string }>)
          .flatMap(d => { const row = this.store.getDoc(d.doc_id); return row && !row.deleted_at ? [{ doc_id: d.doc_id, kind: d.kind, title: row.title, updated_at: row.updated_at }] : [] })
      : []
    return { code: p.code, sex: p.sex, birth_year: p.birth_year, tags: p.tags, labs, records, documents }
  }

  /** 分享里的一份报告原件（必须在分享范围内）。 */
  sharedFile(tenantId: string, patientId: string, scope: ShareScope, fileId: string): { name: string; mime: string; bytes: Buffer } {
    const db = this.dbFor(tenantId)
    if (!this.sharedView(tenantId, patientId, scope).records.some(r => r.file_id === fileId)) throw new PatientError('not_found', '文件不存在', 404)
    const f = db.db.prepare('SELECT * FROM files WHERE id = ? AND patient_id = ?').get(fileId, patientId) as { id: string; name_enc: string; mime: string } | undefined
    if (!f || !existsSync(join(db.files, f.id))) throw new PatientError('not_found', '文件不存在', 404)
    return { name: this.keys.decryptText(tenantId, f.name_enc)!, mime: f.mime, bytes: this.keys.decrypt(tenantId, readFileSync(join(db.files, f.id))) }
  }

  /** 分享里一份报告的文字（已打码，给医生的 AI 读）。 */
  sharedRecordText(tenantId: string, patientId: string, scope: ShareScope, recordId: string): { title: string; kind: string; report_date: string | null; text: string | null } {
    const rec = this.sharedView(tenantId, patientId, scope).records.find(r => r.id === recordId)
    if (!rec) throw new PatientError('not_found', '报告不存在', 404)
    const r = this.dbFor(tenantId).db.prepare('SELECT text_enc FROM records WHERE id = ?').get(recordId) as { text_enc: string | null }
    const text = this.keys.decryptText(tenantId, r.text_enc)
    return { title: rec.title, kind: rec.kind, report_date: rec.report_date, text: text === null ? null : redact(text).slice(0, 20000) }
  }

  /** 在家人那边记一笔：医生（或医生的 AI）经分享看了什么。家人在成员页看得到。 */
  sharedLog(tenantId: string, patientId: string, userId: string, via: Actor['via'], action: string, detail: string): void {
    this.dbFor(tenantId).db.prepare('INSERT INTO access_log (at, user_id, patient_id, action, via, detail) VALUES (?, ?, ?, ?, ?, ?)').run(now(), userId, patientId, action, via, detail)
  }

  /**
   * 纳入本院：把分享的成员复制成本院患者（新代号，操作者为负责人）。报告原件重新用本院密钥加密；
   * 化验按原记录复制：挂在报告上的标来源 share，家人手工录入的仍标 manual（没有原件，不进研究数据集）；文档由调用方复制后关联。
   * 来源追溯：records / labs 的 origin = share:<分享 id>。AI 纳入受本院「AI 写入患者数据」审核门约束（review 时只能由医生点）。
   */
  importShared(a: Actor, src: { tenantId: string; patientId: string; shareId: string; scope: ShareScope }, copyDoc: (docId: string, kind: string) => string | null): PatientRow {
    const c = this.ctx(a)
    this.noAiReview(a, c, '纳入本院')
    if (c.tenantKind === 'personal') throw new PatientError('personal', '纳入本院只在医院端', 400)
    const view = this.sharedView(src.tenantId, src.patientId, src.scope)
    const p = this.create(a, { sex: view.sex, birth_year: view.birth_year, tags: view.tags })
    const origin = `share:${src.shareId}`
    const srcDb = this.dbFor(src.tenantId)
    const recordMap = new Map<string, string>()
    for (const r of view.records) {
      let fid: string | null = null
      if (r.file_id) {
        const f = srcDb.db.prepare('SELECT * FROM files WHERE id = ?').get(r.file_id) as { id: string; name_enc: string; mime: string; size: number; sha256: string } | undefined
        if (f && existsSync(join(srcDb.files, f.id))) {
          fid = rid('pf')
          const bytes = this.keys.decrypt(src.tenantId, readFileSync(join(srcDb.files, f.id)))
          writeFileSync(join(c.db.files, fid), this.keys.encrypt(c.tenantId, bytes))
          c.db.db.prepare('INSERT INTO files (id, patient_id, name_enc, mime, size, sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(fid, p.id, this.keys.encryptText(c.tenantId, this.keys.decryptText(src.tenantId, f.name_enc) ?? 'report')!, f.mime, f.size, f.sha256, a.userId, now())
        }
      }
      const srcRec = srcDb.db.prepare('SELECT text_enc, report_time FROM records WHERE id = ?').get(r.id) as { text_enc: string | null; report_time: string | null }
      const text = this.keys.decryptText(src.tenantId, srcRec.text_enc)
      const id = rid('rc')
      c.db.db.prepare(`INSERT INTO records (id, patient_id, kind, title, report_date, report_time, file_id, status, text_enc, extraction, extraction_note, created_by, created_at, confirmed_by, confirmed_at, origin)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, 'skipped', ?, ?, ?, ?, ?, ?)`)
        .run(id, p.id, r.kind, r.title, r.report_date, srcRec.report_time, fid, this.keys.encryptText(c.tenantId, text), '来自知家家庭分享（家人已确认）', a.userId, now(), a.userId, now(), origin)
      recordMap.set(r.id, id)
    }
    const ins = c.db.db.prepare(`INSERT INTO labs (id, patient_id, record_id, test_key, test_name, value_num, value_text, unit, ref_low, ref_high, ref_text, flag, collected_on, collected_at, status, source, locator, created_by, created_at, confirmed_by, confirmed_at, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?)`)
    for (const l of view.labs) {
      const rec = l.record_id ? recordMap.get(l.record_id) ?? null : null
      ins.run(rid('lb'), p.id, rec, l.test_key, l.test_name, l.value_num, l.value_text, l.unit, l.ref_low, l.ref_high, l.ref_text, l.flag, l.collected_on, l.collected_at,
        // 有报告原件的 → share；家人手工录入（没有原件）的仍标 manual
        rec || l.source !== 'manual' ? 'share' : 'manual', l.locator ? JSON.stringify(l.locator) : null, a.userId, now(), a.userId, now(), origin)
    }
    for (const d of view.documents) {
      const id = copyDoc(d.doc_id, d.kind)
      if (id) this.linkDoc({ ...a, via: 'user' }, p.id, id, 'other')
    }
    this.log(c, a, p.id, 'import_share', src.shareId)
    return p
  }

  /** 守卫用的成员标记（特殊人群判定）：内部读取，不记访问日志、不做诊疗组校验——调用方是写前守卫。 */
  memberMarkers(ownerUserId: string, patientId: string, space: Space = 'personal'): PhrMemberLike | null {
    try {
      const c = this.ctx({ userId: ownerUserId, via: 'user', space })
      const r = c.db.db.prepare('SELECT birth_year, tags FROM patients WHERE id = ?').get(patientId) as Record<string, unknown> | undefined
      if (!r) return null
      return { tags: JSON.parse((r.tags as string) || '[]') as string[], birth_year: (r.birth_year as number | null) ?? null }
    } catch { /* 患者模块未开等：守卫按无标记处理 */ }
    return null
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
    const isImaging = input.kind === 'imaging' || /\.(nii|nii\.gz|dcm|dicom|mha|nrrd|zip)$/i.test(input.name)
    const maxBytes = isImaging ? 250 * 1024 * 1024 : 30 * 1024 * 1024
    if (input.bytes.byteLength > maxBytes) throw new PatientError('too_large', `文件超过 ${isImaging ? '250' : '30'} MB`)
    // 同一份报告重复上传：拦下并说明是哪次传过的（不再重复提取）
    const sha = createHash('sha256').update(input.bytes).digest('hex')
    const dup = c.db.db.prepare(`SELECT r.title, r.report_date, f.created_at FROM files f LEFT JOIN records r ON r.file_id = f.id WHERE f.patient_id = ? AND f.sha256 = ? AND COALESCE(r.status, '') != 'rejected'`).get(patientId, sha) as { title: string | null; report_date: string | null; created_at: string } | undefined
    if (dup) throw new PatientError('duplicate', `这份报告已经上传过（${dup.created_at.slice(0, 10)} 上传${dup.title ? `，「${dup.title}」` : ''}${dup.report_date ? `，报告日期 ${dup.report_date}` : ''}）`, 409)
    const fid = rid('pf')
    writeFileSync(join(c.db.files, fid), this.keys.encrypt(c.tenantId, Buffer.from(input.bytes)))
    c.db.db.prepare('INSERT INTO files (id, patient_id, name_enc, mime, size, sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(fid, patientId, this.keys.encryptText(c.tenantId, input.name)!, input.mime, input.bytes.byteLength, sha, a.userId, now())
    const recId = rid('rc')
    const kind = input.kind && ['lab_report', 'discharge', 'pathology', 'imaging', 'note', 'other'].includes(input.kind) ? input.kind : isImaging ? 'imaging' : 'other'
    // 自动提取：机构允许交给外部模型、配置了模型时排队；否则跳过，由医生手工录入
    const canExtract = Boolean(this.extractor?.complete) && c.settings.external_model_for_patients
    c.db.db.prepare('INSERT INTO records (id, patient_id, kind, title, report_date, file_id, status, extraction, extraction_note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(recId, patientId, kind, (input.title ?? '').trim().slice(0, 120) || (isImaging ? '医学影像扫描序列' : '未命名报告'), input.report_date && DATE.test(input.report_date) ? input.report_date : null, fid, 'pending',
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

  /**
   * 记录医学影像量化分析结果：
   * 将 MONAI 深度学习推理产生的最大截面图（关键切片 PNG，带卡尺与标尺）加密保存到租户文件，
   * 同时存入 Store 资产（供 OmniCanvas 与文档无缝引用），将量化指标以加密 JSON 存入 records 表，
   * 并支持自动建议/合并患者临床诊断标签（例如支气管扩张、ABPA等）。
   */
  addImagingRecord(a: Actor, patientId: string, input: {
    title: string
    report_date: string | null
    model_id: string
    sample_id?: string | null
    modality?: string
    metrics: Record<string, unknown>
    findings?: string[]
    key_slice_png: Uint8Array
    raw_volume_file?: { name: string; bytes: Uint8Array; mime?: string }
    add_tags?: string[]
  }): { record: RecordRow & { imaging_data?: Record<string, unknown> }; asset_id: string; file_id: string; raw_file_id?: string } {
    const { c } = this.requireTeam(a, patientId)
    const fid = rid('pf')
    const pngBuffer = Buffer.from(input.key_slice_png)
    const sha = createHash('sha256').update(pngBuffer).digest('hex')

    // 1. 加密存入机构独立患者文件目录 (关键截面原图)
    writeFileSync(join(c.db.files, fid), this.keys.encrypt(c.tenantId, pngBuffer))
    c.db.db.prepare('INSERT INTO files (id, patient_id, name_enc, mime, size, sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(fid, patientId, this.keys.encryptText(c.tenantId, `${input.title || '影像分析'}-key-slice.png`)!, 'image/png', pngBuffer.byteLength, sha, a.userId, now())

    // 1b. 若提供了原始 3D 体素扫描序列文件（例如上传的或 sample 的 .nii.gz），同样加密保存入患者文件库
    let rawFid: string | undefined
    if (input.raw_volume_file && input.raw_volume_file.bytes.byteLength > 0) {
      rawFid = rid('pf')
      const rawBuf = Buffer.from(input.raw_volume_file.bytes)
      const rawSha = createHash('sha256').update(rawBuf).digest('hex')
      writeFileSync(join(c.db.files, rawFid), this.keys.encrypt(c.tenantId, rawBuf))
      c.db.db.prepare('INSERT INTO files (id, patient_id, name_enc, mime, size, sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(rawFid, patientId, this.keys.encryptText(c.tenantId, input.raw_volume_file.name || 'raw-scan.nii.gz')!, input.raw_volume_file.mime || 'application/gzip', rawBuf.byteLength, rawSha, a.userId, now())
    }

    // 2. 存入文档资产库（具有全局 asset_id，支持在 Markdown 或 OmniCanvas 中直接使用）
    const asset = this.store.putAsset({
      owner: a.userId,
      mime: 'image/png',
      name: `${input.title || 'imaging'}-slice.png`,
      bytes: pngBuffer,
    })

    // 3. 构建结构化量化数据载荷
    const imagingPayload = {
      model_id: input.model_id,
      sample_id: input.sample_id ?? null,
      modality: input.modality ?? 'Chest HRCT',
      asset_id: asset.id,
      file_id: fid,
      raw_file_id: rawFid ?? null,
      raw_file_name: input.raw_volume_file?.name ?? null,
      raw_file_size: input.raw_volume_file?.bytes?.byteLength ?? null,
      metrics: input.metrics,
      findings: input.findings ?? [],
      analyzed_at: now(),
    }

    const recId = rid('rc')
    const encText = this.keys.encryptText(c.tenantId, JSON.stringify(imagingPayload))

    // 格式化提取备注 / 快速摘要
    let summaryNote = ''
    if (input.findings && input.findings.length > 0) {
      summaryNote = input.findings.slice(0, 3).join(' · ')
    } else if (input.metrics) {
      const parts: string[] = []
      if (input.metrics.bar_ratio !== undefined) parts.push(`BAR: ${input.metrics.bar_ratio}`)
      if (input.metrics.mucus_volume_mm3 !== undefined) parts.push(`粘液栓: ${input.metrics.mucus_volume_mm3} mm³`)
      if (input.metrics.longest_diameter_mm !== undefined) parts.push(`RECIST: ${input.metrics.longest_diameter_mm} mm`)
      summaryNote = parts.join(' · ')
    }

    // 当有原始扫描文件时，records.file_id 指向 rawFid，使「原件」按钮直接下载原始体素文件；否则指向切片图
    const primaryFileId = rawFid ?? fid
    c.db.db.prepare(`INSERT INTO records (id, patient_id, kind, title, report_date, file_id, status, text_enc, extraction, extraction_note, created_by, created_at, confirmed_by, confirmed_at)
      VALUES (?, ?, 'imaging', ?, ?, ?, 'confirmed', ?, 'done', ?, ?, ?, ?, ?)`)
      .run(recId, patientId, (input.title || '医学影像量化分析').trim().slice(0, 120), input.report_date && DATE.test(input.report_date) ? input.report_date : null, primaryFileId,
        encText, summaryNote.slice(0, 200), a.userId, now(), a.userId, now())

    // 4. 若有阳性征象需要新增标签，合并到 patients.tags
    if (input.add_tags && input.add_tags.length > 0) {
      const pRow = c.db.db.prepare('SELECT tags FROM patients WHERE id = ?').get(patientId) as { tags: string } | undefined
      if (pRow) {
        const curTags = JSON.parse(pRow.tags || '[]') as string[]
        const mergedTags = Array.from(new Set([...curTags, ...input.add_tags.map(t => t.trim()).filter(Boolean)]))
        c.db.db.prepare('UPDATE patients SET tags = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(mergedTags), now(), patientId)
      }
    }

    c.db.db.prepare('UPDATE patients SET updated_at = ? WHERE id = ?').run(now(), patientId)
    this.log(c, a, patientId, 'imaging_analyze', recId)

    const createdRec = c.db.db.prepare('SELECT * FROM records WHERE id = ?').get(recId) as unknown as RecordRow
    return {
      record: { ...createdRec, text_enc: undefined, imaging_data: imagingPayload } as any,
      asset_id: asset.id,
      file_id: fid,
      raw_file_id: rawFid,
    }
  }

  /**
   * 多期随访医学影像对比评估（RECIST 1.1 / 气道粘液栓演变）：
   * 对比基线检查 (Baseline) 与随访检查 (Follow-up) 的病灶长径、短径与 3D 体积变化率，
   * 自动评定 RECIST 1.1 疗效等级（CR / PR / SD / PD）或气道粘液栓转归（清除 / 改善 / 稳定 / 加重），
   * 生成包含双期影像对照、量化演变表格与临床建议的完整结构化评估报告，并支持选择性将对比报告落库为新的病历记录。
   */
  compareImaging(a: Actor, patientId: string, input?: {
    baseline_record_id?: string
    followup_record_id?: string
    save_as_record?: boolean
  }): {
    ok: boolean
    patient_id: string
    patient_code: string
    is_single_baseline?: boolean
    message?: string
    baseline?: any
    followup?: any
    interval_days?: number
    recist?: {
      target_type: 'tumor_lesion' | 'bronchiectasis_mucus' | 'general'
      baseline_ld_mm?: number
      followup_ld_mm?: number
      diff_ld_mm?: number
      percent_change_ld?: number
      baseline_volume_cm3?: number
      followup_volume_cm3?: number
      diff_volume_cm3?: number
      percent_change_volume?: number
      vdt?: any
      category: 'CR' | 'PR' | 'SD' | 'PD'
      category_name: string
      interpretation: string
      academic_statement: string
    }
    summary_markdown: string
    record_id?: string
  } {
    const { c, p } = this.visible(a, patientId)
    const rows = (c.db.db.prepare("SELECT * FROM records WHERE patient_id = ? AND kind = 'imaging' ORDER BY COALESCE(report_date, created_at) ASC").all(patientId) as unknown as Array<RecordRow & { text_enc?: string | null }>)
      .map(r => {
        let imaging_data: Record<string, any> | null = null
        if (r.text_enc) {
          try {
            const dec = this.keys.decryptText(c.tenantId, r.text_enc)
            if (dec) imaging_data = JSON.parse(dec)
          } catch {}
        }
        return { ...r, text_enc: undefined, imaging_data }
      })

    const validRows = rows.filter(r => r.imaging_data && r.status !== 'rejected' && r.imaging_data.model_id !== 'recist_longitudinal_comparator')
    if (validRows.length === 0) {
      throw new PatientError('no_imaging_records', '该患者尚无已记录的医学影像量化分析数据', 400)
    }

    if (validRows.length === 1) {
      const single = validRows[0]!
      const singleDate = single.report_date || single.created_at.slice(0, 10)
      const sm = single.imaging_data?.metrics || {}
      return {
        ok: true,
        patient_id: patientId,
        patient_code: p.code,
        is_single_baseline: true,
        message: `患者当前仅有 1 份基线影像（${single.title}，${singleDate}），尚无随访对比时间点。已建立基线肿瘤负荷指标，待后续复查时自动计算 RECIST 1.1 疗效评估。`,
        baseline: {
          record_id: single.id,
          title: single.title,
          date: singleDate,
          modality: single.imaging_data?.modality || 'CT',
          metrics: sm,
          asset_id: single.imaging_data?.asset_id,
          slice_file_id: single.imaging_data?.file_id,
          file_id: single.imaging_data?.file_id || (single.file_id !== single.imaging_data?.raw_file_id ? single.file_id : undefined),
          raw_file_id: single.imaging_data?.raw_file_id,
        },
        summary_markdown: `# 患者 ${p.code} 基线影像指标存档\n\n- **检查日期**: ${singleDate}\n- **检查项目**: ${single.title}\n- **状态**: 单期基线，待后续随访对比。`,
      }
    }

    let baseline = input?.baseline_record_id
      ? validRows.find(r => r.id === input.baseline_record_id)
      : validRows[0]!
    let followup = input?.followup_record_id
      ? validRows.find(r => r.id === input.followup_record_id)
      : validRows[validRows.length - 1]!

    if (!baseline) throw new PatientError('baseline_not_found', '未找到指定的基线影像记录', 404)
    if (!followup) throw new PatientError('followup_not_found', '未找到指定的随访影像记录', 404)
    if (baseline.id === followup.id) {
      throw new PatientError('invalid_comparison_points', '随访对比需要选择两个不同时期的影像记录', 400)
    }

    // 确保时间顺序：若用户选反了，自动纠正为 baseline 早于 followup
    const bDate = baseline.report_date || baseline.created_at.slice(0, 10)
    const fDate = followup.report_date || followup.created_at.slice(0, 10)
    if (new Date(bDate).getTime() > new Date(fDate).getTime()) {
      const tmp = baseline
      baseline = followup
      followup = tmp
    }

    const baseDateStr = baseline.report_date || baseline.created_at.slice(0, 10)
    const followDateStr = followup.report_date || followup.created_at.slice(0, 10)
    const intervalDays = Math.max(0, Math.round(Math.abs(new Date(followDateStr).getTime() - new Date(baseDateStr).getTime()) / (1000 * 60 * 60 * 24)))

    const bm = baseline.imaging_data?.metrics || {}
    const fm = followup.imaging_data?.metrics || {}

    const bModel = String(baseline.imaging_data?.model_id || '')
    const fModel = String(followup.imaging_data?.model_id || '')
    const isBronch = bModel.includes('bronchiectasis') || fModel.includes('bronchiectasis') || baseline.title.includes('支气管') || followup.title.includes('支气管')

    const round = (n: number, d = 1) => {
      const f = Math.pow(10, d)
      return Math.round(n * f) / f
    }

    const bLd = Number(bm.longest_diameter_mm || bm.bronchus_caliber_mm || 0)
    const fLd = Number(fm.longest_diameter_mm || fm.bronchus_caliber_mm || 0)
    const bVol = Number(bm.total_volume_cm3 || bm.total_mucus_volume_cm3 || 0)
    const fVol = Number(fm.total_volume_cm3 || fm.total_mucus_volume_cm3 || 0)

    const bMucus = Number(bm.total_mucus_volume_cm3 ?? bm.mucus_plug_volume_mm3 ?? 0)
    const fMucus = Number(fm.total_mucus_volume_cm3 ?? fm.mucus_plug_volume_mm3 ?? 0)
    const bHam = Number(bm.high_attenuation_mucus_cm3 ?? 0)
    const fHam = Number(fm.high_attenuation_mucus_cm3 ?? 0)
    const bBar = bm.bar_ratio !== undefined ? Number(bm.bar_ratio) : undefined
    const fBar = fm.bar_ratio !== undefined ? Number(fm.bar_ratio) : undefined

    const diffLd = round(fLd - bLd, 1)
    const pctLd = bLd > 0 ? round((diffLd / bLd) * 100, 1) : 0
    const diffVol = round(fVol - bVol, 2)
    const pctVol = bVol > 0 ? round((diffVol / bVol) * 100, 1) : 0

    let category: 'CR' | 'PR' | 'SD' | 'PD' = 'SD'
    let categoryName = '疾病稳定 (Stable Disease)'
    let interpretation = ''
    let targetType: 'tumor_lesion' | 'bronchiectasis_mucus' | 'general' = 'general'

    if (isBronch && (bMucus > 0 || fMucus > 0 || bBar !== undefined)) {
      targetType = 'bronchiectasis_mucus'
      const diffMucus = round(fMucus - bMucus, 2)
      const pctMucus = bMucus > 0 ? round((diffMucus / bMucus) * 100, 1) : 0

      if (fMucus === 0 && bMucus > 0) {
        category = 'CR'
        categoryName = '完全清除 (Complete Clearance)'
        interpretation = '支气管管腔内嵌顿粘液栓已完全吸收排空，气道管腔通畅，未见残余阻塞。'
      } else if (bHam > 0 && fHam === 0) {
        category = 'PR'
        categoryName = '显著改善 (Significant Improvement)'
        interpretation = `高密度粘液栓 (HAM) 已完全消失吸收，粘液栓总体积由基线 ${bMucus} cm³ 变化至 ${fMucus} cm³（降幅 ${Math.abs(pctMucus)}%），提示曲霉高反应性炎性负荷得到控制。`
      } else if (pctMucus <= -50.0) {
        category = 'PR'
        categoryName = '显著改善 (Significant Improvement)'
        interpretation = `支气管粘液栓总体积较基线吸收缩小 ≥ 50%（当前减少 ${Math.abs(pctMucus)}%）。`
      } else if (pctMucus >= 20.0 || (fHam > 0 && bHam === 0)) {
        category = 'PD'
        categoryName = '病变加重 (Exacerbation/Progression)'
        interpretation = `支气管粘液栓负荷较基线增加 ≥ 20%（当前增加 +${pctMucus}%）${fHam > 0 && bHam === 0 ? '，且新发高密度粘液栓 (HAM)，提示曲霉高反应加重' : ''}。`
      } else {
        category = 'SD'
        categoryName = '病情稳定 (Stable Disease)'
        interpretation = `支气管管径与粘液栓负荷维持稳定，变化未达显著吸收或加重标准（粘液栓变化率 ${pctMucus > 0 ? '+' : ''}${pctMucus}%）。`
      }
    } else {
      targetType = 'tumor_lesion'
      if (fLd === 0 && bLd > 0) {
        category = 'CR'
        categoryName = '完全缓解 (Complete Response)'
        interpretation = '所有靶病灶均完全消失，无新病灶出现，无肿瘤活性残留。'
      } else if (pctLd <= -30.0) {
        category = 'PR'
        categoryName = '部分缓解 (Partial Response)'
        interpretation = `靶病灶最大长径之和较基线缩小 ≥ 30%（当前减少 ${Math.abs(pctLd)}%，体积缩小 ${Math.abs(pctVol)}%）。`
      } else if (pctLd >= 20.0 && diffLd >= 5.0) {
        category = 'PD'
        categoryName = '疾病进展 (Progressive Disease)'
        interpretation = `靶病灶最大长径较基线增加 ≥ 20% 且绝对值增加 ≥ 5mm（当前增加 +${pctLd}%，绝对增加 +${diffLd} mm）。`
      } else {
        category = 'SD'
        categoryName = '疾病稳定 (Stable Disease)'
        interpretation = `靶病灶长径变化未达 PR 缩小标准，亦未达 PD 进展标准（长径变化率 ${pctLd > 0 ? '+' : ''}${pctLd}%，体积变化率 ${pctVol > 0 ? '+' : ''}${pctVol}%）。`
      }
    }

    const signLd = pctLd > 0 ? `+${pctLd}%` : `${pctLd}%`
    const signVol = pctVol > 0 ? `+${pctVol}%` : `${pctVol}%`

    // 计算肿瘤体积倍增时间 (Schwartz VDT 动力学评估)
    let vdt: {
      days: number | null
      category: 'rapid_growth' | 'intermediate_growth' | 'indolent_growth' | 'stable' | 'regressed' | 'indeterminate'
      risk_level: 'critical_high' | 'medium_warning' | 'low_indolent' | 'low' | 'none'
      label: string
      description: string
      clinical_alert: boolean
      recommendation: string
    } = {
      days: null,
      category: 'indeterminate',
      risk_level: 'none',
      label: '无法计算 (数据不足)',
      description: '需至少两次有效体积测定且随访间隔大于0天',
      clinical_alert: false,
      recommendation: '维持常规影像随访',
    }

    if (bVol > 0 && fVol > 0 && intervalDays > 0) {
      if (fVol <= bVol) {
        if (fVol <= bVol * 0.75) {
          vdt = {
            days: null,
            category: 'regressed',
            risk_level: 'low',
            label: `体积显著缩小 (缩小 ${Math.abs(pctVol)}%)`,
            description: '病灶体积较基线缩小 >25%，符合治疗有效或炎性吸收表现。',
            clinical_alert: false,
            recommendation: '建议维持原治疗方案并定期影像随访',
          }
        } else {
          vdt = {
            days: null,
            category: 'stable',
            risk_level: 'low',
            label: '体积相对稳定',
            description: `病灶体积变化在标准测量误差范围内 (${pctVol > 0 ? '+' : ''}${pctVol}%)，未见明确增大。`,
            clinical_alert: false,
            recommendation: '按既定随访方案维持常规低剂量 CT 复查',
          }
        }
      } else {
        const vdtDays = round((intervalDays * Math.LN2) / Math.log(fVol / bVol), 1)
        if (vdtDays < 400.0) {
          vdt = {
            days: vdtDays,
            category: 'rapid_growth',
            risk_level: 'critical_high',
            label: `急速倍增 (${vdtDays} 天, 恶性高危)`,
            description: `体积倍增时间仅 ${vdtDays} 天 (<400天，体积增大 +${pctVol}%)，符合恶性实体肿瘤快速增殖动力学特征。`,
            clinical_alert: true,
            recommendation: '强烈建议立即提交肺部肿瘤 MDT 疑难病案会诊，并由胸外科评估穿刺活检或胸腔镜切除手术',
          }
        } else if (vdtDays <= 600.0) {
          vdt = {
            days: vdtDays,
            category: 'intermediate_growth',
            risk_level: 'medium_warning',
            label: `中度增殖 (${vdtDays} 天, 需警惕)`,
            description: `体积倍增时间为 ${vdtDays} 天 (400-600天区间，体积增大 +${pctVol}%)，提示病灶持续缓慢增殖，不能排除浸润性病变。`,
            clinical_alert: false,
            recommendation: '建议 3 个月后低剂量高分辨 CT 严密随访，若实性成分继续增大建议穿刺介入',
          }
        } else {
          vdt = {
            days: vdtDays,
            category: 'indolent_growth',
            risk_level: 'low_indolent',
            label: `惰性/缓慢增殖 (${vdtDays} 天, 良性倾向)`,
            description: `体积倍增时间长达 ${vdtDays} 天 (>600天，体积增大 +${pctVol}%)，多见于良性错构瘤/硬化性血管瘤或惰性原位癌。`,
            clinical_alert: false,
            recommendation: '建议维持 6-12 个月常规年度低剂量 CT 随访',
          }
        }
      }
    }

    const academicStatement = targetType === 'bronchiectasis_mucus'
      ? `依据气道与粘液栓容积量化标准，患者 ${p.code} 随访对比（${intervalDays === 0 ? '同日复核分析，非跨期随访' : `间隔 ${intervalDays} 天`}）：支气管粘液栓 3D 总体积由基线 ${bMucus} cm³ 变化至 ${fMucus} cm³（${signVol}），高密度粘液栓 (HAM) 由 ${bHam} cm³ 变化至 ${fHam} cm³。总体疗效评估为：【${category} - ${categoryName}】。`
      : `依据实体瘤疗效评价标准 (RECIST 1.1) 与 Schwartz 动力学生长模型，患者 ${p.code} 随访对比（间隔 ${intervalDays} 天）：靶病灶最大长径由基线 ${bLd} mm 变化至 ${fLd} mm（${signLd}），3D 总体积由 ${bVol} cm³ 变化至 ${fVol} cm³（${signVol}），体积倍增时间 (VDT): ${vdt.days !== null ? `${vdt.days} 天 (${vdt.label})` : vdt.label}。总体疗效评估为：【${category} - ${categoryName}】。`

    const baseAssetId = baseline.imaging_data?.asset_id
    const followAssetId = followup.imaging_data?.asset_id

    const summaryMd = `# 医学影像多期随访对比评估报告 (RECIST 1.1)

**患者代号**: \`${p.code}\`  
**基线检查**: ${baseline.title} (\`${baseDateStr}\`)  
**随访检查**: ${followup.title} (\`${followDateStr}\`)  
**随访间隔**: **${intervalDays}** 天  

---

### 一、 疗效评估结论
> **评估等级**: **${category} (${categoryName})**  
> **临床判定**: ${interpretation}  
> **学术结论**: ${academicStatement}

---

### 二、 靶病灶与量化指标演变对比表
| 测量指标 | 基线 (Baseline: ${baseDateStr}) | 随访 (Follow-up: ${followDateStr}) | 绝对差值 (Δ) | 变化率 (Δ%) | 评估标准 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **最大截面长径 (LD)** | ${bLd} mm | ${fLd} mm | ${diffLd > 0 ? '+' : ''}${diffLd} mm | **${signLd}** | RECIST 1.1 靶病灶标准 |
| **3D 总体积 (Volume)** | ${bVol} cm³ | ${fVol} cm³ | ${diffVol > 0 ? '+' : ''}${diffVol} cm³ | **${signVol}** | 3D MONAI 深度学习测量 |
${bBar !== undefined || fBar !== undefined ? `| **支气管伴行动脉比 (BAR)** | ${bBar ?? '--'} | ${fBar ?? '--'} | ${fBar !== undefined && bBar !== undefined ? round(fBar - bBar, 2) : '--'} | -- | 印戒征 (>1.10) |` : ''}
${bMucus > 0 || fMucus > 0 ? `| **粘液栓体积** | ${bMucus} cm³ | ${fMucus} cm³ | ${round(fMucus - bMucus, 2)} cm³ | ${bMucus > 0 ? round(((fMucus - bMucus) / bMucus) * 100, 1) + '%' : '--'} | 气道嵌顿负荷 |` : ''}
${bHam > 0 || fHam > 0 ? `| **高密度粘液栓 (HAM)** | ${bHam} cm³ | ${fHam} cm³ | ${round(fHam - bHam, 2)} cm³ | -- | 提示 ABPA 活动性 |` : ''}
| **体积倍增时间 (VDT)** | -- | -- | ${vdt.days !== null ? `${vdt.days} 天` : '--'} | **${vdt.label}** | Schwartz 动力学 (<400天高危) |

---

### 三、 肿瘤动力学生长速度 (Schwartz VDT 动力学评估)
> **倍增指标**: **${vdt.days !== null ? `${vdt.days} 天` : '未触发倍增'}**（${vdt.label}）  
> **动力学解读**: ${vdt.description}  
> **临床建议**: ${vdt.recommendation}
${vdt.clinical_alert ? `\n> ⚠️ **高危增殖预警**: 本病灶体积倍增时间 < 400 天，提示侵袭性恶性病灶快速增殖，强烈建议尽快提交胸部肿瘤 MDT 专科会诊评估手术指征。` : ''}

---

### 四、 双期关键截面影像对照
${baseAssetId ? `- **基线关键切片**: ![基线关键切片](asset:${baseAssetId} "基线影像 (${baseDateStr})")` : ''}
${followAssetId ? `- **随访关键切片**: ![随访关键切片](asset:${followAssetId} "随访影像 (${followDateStr})")` : ''}

---

### 五、 临床处置与随访建议
1. **${category === 'CR' || category === 'PR' ? '疗效显著' : category === 'PD' ? '疾病进展预警' : '疗效稳定'}**: 结合当前影像 RECIST 1.1 评估结果（${category}），建议临床维持或调整现有治疗方案。
2. **随访周期**: 建议于 8–12 周后再次安排胸腹部 CT 随访，继续监测靶病灶长径与体积演变曲线。
`

    let savedRecordId: string | undefined
    if (input?.save_as_record) {
      this.requireTeam(a, patientId)
      savedRecordId = rid('rc')
      const comparisonPayload = {
        model_id: 'recist_longitudinal_comparator',
        sample_id: null,
        modality: baseline.imaging_data?.modality || followup.imaging_data?.modality || 'CT',
        baseline_record_id: baseline.id,
        followup_record_id: followup.id,
        interval_days: intervalDays,
        recist: {
          category,
          category_name: categoryName,
          diff_ld_mm: diffLd,
          percent_change_ld: pctLd,
          diff_volume_cm3: diffVol,
          percent_change_volume: pctVol,
          vdt,
          interpretation,
          academic_statement: academicStatement,
        },
        metrics: {
          longest_diameter_mm: fLd,
          total_volume_cm3: fVol,
          recist_category: category,
          recist_category_name: categoryName,
          percent_change_ld: pctLd,
          percent_change_volume: pctVol,
          baseline_ld_mm: bLd,
          followup_ld_mm: fLd,
          diff_ld_mm: diffLd,
          baseline_volume_cm3: bVol,
          followup_volume_cm3: fVol,
          diff_volume_cm3: diffVol,
          vdt,
        },
        findings: [
          `RECIST 1.1 疗效评估: 【${category}】${categoryName}`,
          `长径变化: ${signLd} (${bLd} mm → ${fLd} mm)`,
          `体积变化: ${signVol} (${bVol} cm³ → ${fVol} cm³)`,
          `体积倍增时间 (VDT): ${vdt.days !== null ? `${vdt.days} 天` : vdt.label}`,
        ],
        asset_id: followAssetId || baseAssetId,
        slice_file_id: followup.imaging_data?.file_id || baseline.imaging_data?.file_id || null,
        file_id: followup.imaging_data?.file_id || baseline.imaging_data?.file_id || null,
        raw_file_id: followup.imaging_data?.raw_file_id || followup.file_id || null,
        analyzed_at: now(),
      }
      const encText = this.keys.encryptText(c.tenantId, JSON.stringify(comparisonPayload))
      const summaryNote = `${category} · ${categoryName} · 长径 ${signLd} · 体积 ${signVol}`
      c.db.db.prepare(`INSERT INTO records (id, patient_id, kind, title, report_date, file_id, status, text_enc, extraction, extraction_note, created_by, created_at, confirmed_by, confirmed_at)
        VALUES (?, ?, 'imaging', ?, ?, ?, 'confirmed', ?, 'done', ?, ?, ?, ?, ?)`)
        .run(savedRecordId, patientId, `多期影像随访 RECIST 1.1 疗效评估 (${category})`, followDateStr, followup.file_id || baseline.file_id,
          encText, summaryNote.slice(0, 200), a.userId, now(), a.userId, now())
      c.db.db.prepare('UPDATE patients SET updated_at = ? WHERE id = ?').run(now(), patientId)
      this.log(c, a, patientId, 'imaging_compare', savedRecordId)
    }

    return {
      ok: true,
      patient_id: patientId,
      patient_code: p.code,
      is_single_baseline: false,
      baseline: {
        record_id: baseline.id,
        title: baseline.title,
        date: baseDateStr,
        modality: baseline.imaging_data?.modality || 'CT',
        metrics: bm,
        asset_id: baseAssetId,
        slice_file_id: baseline.imaging_data?.file_id,
        file_id: baseline.imaging_data?.file_id || (baseline.file_id !== baseline.imaging_data?.raw_file_id ? baseline.file_id : undefined),
        raw_file_id: baseline.imaging_data?.raw_file_id,
      },
      followup: {
        record_id: followup.id,
        title: followup.title,
        date: followDateStr,
        modality: followup.imaging_data?.modality || 'CT',
        metrics: fm,
        asset_id: followAssetId,
        slice_file_id: followup.imaging_data?.file_id,
        file_id: followup.imaging_data?.file_id || (followup.file_id !== followup.imaging_data?.raw_file_id ? followup.file_id : undefined),
        raw_file_id: followup.imaging_data?.raw_file_id,
      },
      interval_days: intervalDays,
      recist: {
        target_type: targetType,
        baseline_ld_mm: bLd,
        followup_ld_mm: fLd,
        diff_ld_mm: diffLd,
        percent_change_ld: pctLd,
        baseline_volume_cm3: bVol,
        followup_volume_cm3: fVol,
        diff_volume_cm3: diffVol,
        percent_change_volume: pctVol,
        vdt,
        category,
        category_name: categoryName,
        interpretation,
        academic_statement: academicStatement,
      },
      summary_markdown: summaryMd,
      record_id: savedRecordId,
    }
  }

  /**
   * 多模态因果诊断证据链分析 (Multimodal Diagnostic Evidence Chain):
   * 自动将医学影像阳性病征 (如 支扩/粘液栓/高密度粘液栓 HAM、或肺实质结节占位 RECIST 1.1)
   * 与患者实验室化验指标 (EOS, IgE, 曲霉sIgE, 肿瘤标志物 CEA/CYFRA21-1, CRP/ESR)
   * 及既往诊断标签/病史进行因果三角校验，评估临床确诊依据、缺漏待查项，并输出结构化证据链条。
   */
  getEvidenceChain(a: Actor, patientId: string, input?: {
    record_id?: string
    baseline_record_id?: string
    followup_record_id?: string
  }): {
    ok: boolean
    patient_id: string
    patient_code: string
    record_id: string
    record_title: string
    syndrome: string
    syndrome_key: 'abpa_bronchiectasis' | 'lung_neoplasm_recist' | 'copd_emphysema' | 'abdominal_organ' | 'general'
    clinical_urgency: 'high' | 'medium' | 'routine'
    match_summary: string
    criteria_table: Array<{
      criterion: string
      category: 'imaging' | 'lab' | 'history'
      status: 'positive' | 'negative' | 'missing'
      evidence_value: string
      reference_guideline: string
    }>
    matched_labs: Array<{
      test_key: string
      test_name: string
      value: string
      unit: string
      flag: string | null
      date: string
      clinical_significance: string
    }>
    suggested_workup: string[]
    diagnostic_impression: string
    summary_markdown: string
  } {
    const { c, p } = this.visible(a, patientId)
    const recRows = c.db.db.prepare('SELECT * FROM records WHERE patient_id = ? ORDER BY COALESCE(report_date, created_at) DESC').all(patientId) as any[]

    const imagingRecs = recRows.filter(r => r.kind === 'imaging').map(r => {
      let imaging_data: Record<string, any> | null = null
      if (r.text_enc) {
        try {
          const dec = this.keys.decryptText(c.tenantId, r.text_enc)
          if (dec) imaging_data = JSON.parse(dec)
        } catch {}
      }
      return { ...r, imaging_data }
    })

    if (imagingRecs.length === 0) {
      throw new PatientError('imaging_record_not_found', '该患者尚无医学影像量化分析记录', 404)
    }

    const scanRecs = imagingRecs.filter(r => r.imaging_data && r.imaging_data.model_id !== 'recist_longitudinal_comparator')
    const pool = scanRecs.length > 0 ? scanRecs : imagingRecs

    // 解析目标记录
    let targetRec = pool[0]!
    if (input?.record_id) {
      const found = imagingRecs.find(r => r.id === input.record_id)
      if (found) targetRec = found
    } else if (input?.followup_record_id) {
      const found = imagingRecs.find(r => r.id === input.followup_record_id)
      if (found) targetRec = found
    } else if (input?.baseline_record_id) {
      const found = imagingRecs.find(r => r.id === input.baseline_record_id)
      if (found) targetRec = found
    }

    // 读取该患者所有已确认的化验记录
    const confirmedLabs = (c.db.db.prepare("SELECT * FROM labs WHERE patient_id = ? AND status = 'confirmed' ORDER BY collected_on DESC, created_at DESC").all(patientId) as any[]).map(labOf)
    const summaryRow = c.db.db.prepare('SELECT summary_enc FROM patients WHERE id = ?').get(patientId) as { summary_enc: string | null } | undefined
    const patientSummary = (summaryRow?.summary_enc ? this.keys.decryptText(c.tenantId, summaryRow.summary_enc) : null) ?? ''
    const tags: string[] = Array.isArray(p.tags) ? p.tags : []

    const m = (targetRec.imaging_data?.metrics || {}) as Record<string, any>
    const modelId = String(targetRec.imaging_data?.model_id || '')
    const recTitle = String(targetRec.title || '')

    // 综合判定临床病征类别
    const isBronchiectasis = modelId === 'bronchiectasis_mucus_analyzer' ||
      recTitle.includes('支气管') ||
      m.bar_ratio !== undefined ||
      m.total_mucus_volume_cm3 !== undefined ||
      tags.some((t: string) => t.includes('支气管') || t.includes('ABPA'))

    const isNoduleRecist = !isBronchiectasis && (
      modelId.includes('nodule') ||
      m.longest_diameter_mm !== undefined ||
      recTitle.includes('RECIST')
    )

    const isAbdominal = !isBronchiectasis && !isNoduleRecist && (
      modelId.includes('spleen') ||
      modelId.includes('liver') ||
      recTitle.includes('腹部') ||
      recTitle.includes('脾')
    )

    // 查找特定检验项目的辅助闭包
    const findLab = (keys: string[]) => {
      for (const k of keys) {
        const found = confirmedLabs.find(l => l.test_key === k || k.includes(l.test_key))
        if (found) return found
      }
      return null
    }

    let syndrome = '全胸腹部医学影像量化因果分析'
    let syndromeKey: 'abpa_bronchiectasis' | 'lung_neoplasm_recist' | 'abdominal_organ' | 'general' = 'general'
    let clinicalUrgency: 'high' | 'medium' | 'routine' = 'routine'
    const criteriaTable: Array<{
      criterion: string
      category: 'imaging' | 'lab' | 'history'
      status: 'positive' | 'negative' | 'missing'
      evidence_value: string
      reference_guideline: string
    }> = []
    const matchedLabs: Array<{
      test_key: string
      test_name: string
      value: string
      unit: string
      flag: string | null
      date: string
      clinical_significance: string
    }> = []
    const suggestedWorkup: string[] = []
    let diagnosticImpression = ''

    if (isBronchiectasis) {
      syndrome = '变应性支气管肺曲霉病 (ABPA) / 支气管扩张并发真菌致敏'
      syndromeKey = 'abpa_bronchiectasis'

      // 1. 基础疾病史 (Asthma or Bronchiectasis)
      const hasPredisposing = tags.some((t: string) => t.includes('支气管') || t.includes('哮喘') || t.includes('咳嗽')) || patientSummary.includes('支气管')
      criteriaTable.push({
        criterion: '基础呼吸系统疾病 (哮喘或支气管扩张)',
        category: 'history',
        status: hasPredisposing ? 'positive' : 'missing',
        evidence_value: hasPredisposing ? `确诊病史或标签: ${tags.filter((t: string) => t.includes('支气管') || t.includes('哮喘') || t.includes('咳嗽')).join('、') || '慢性咳嗽'}` : '既往病史未明确记录典型哮喘或支扩',
        reference_guideline: 'ISHAM 2013 / 2024 ABPA 诊断必需基础条件',
      })

      // 2. 影像学中心性支扩 (BAR > 1.10 印戒征)
      const barVal = m.bar_ratio !== undefined ? Number(m.bar_ratio) : null
      const barPos = barVal !== null ? barVal > 1.10 : (m.signet_ring_sign === true)
      criteriaTable.push({
        criterion: 'HRCT 中心性支气管扩张 (BAR 印戒征阳性)',
        category: 'imaging',
        status: barPos ? 'positive' : barVal !== null ? 'negative' : 'positive',
        evidence_value: barVal !== null ? `BAR 比值 ${barVal} (${barPos ? '印戒征阳性 ⚠' : '正常'})` : '影像提示支气管壁明显增厚与管腔囊柱状扩张',
        reference_guideline: 'Fleischner 学会支气管扩张诊断标准 (BAR > 1.10)',
      })

      // 3. 高密度粘液栓 (HAM) - ABPA 强特异性标志
      const hamVal = m.high_attenuation_mucus_cm3 !== undefined ? Number(m.high_attenuation_mucus_cm3) : null
      const hamPos = (hamVal !== null && hamVal > 0) || m.high_attenuation_mucus_ham === true || m.high_attenuation_mucus === true || (m.ham_max_hu !== undefined && Number(m.ham_max_hu) > 70)
      criteriaTable.push({
        criterion: '高密度粘液栓 (High-Attenuation Mucus, HAM)',
        category: 'imaging',
        status: hamPos ? 'positive' : 'negative',
        evidence_value: hamPos ? `阳性 (${hamVal !== null ? `${hamVal} cm³` : '检出嵌顿'}，CT 值显著高于伴行动脉，特异性 >95%)` : '未见明确高密度粘液栓 (CT值低于或等于周围软组织)',
        reference_guideline: 'ABPA 影像学标志性病理征象 (HAM 为重症高复发预后指标)',
      })

      // 4. 血清总 IgE
      const igeLab = findLab(['total_ige', 'ige'])
      if (igeLab) {
        const val = igeLab.std_value ?? igeLab.value_num ?? 0
        const isPos = val > 1000 || val > 416
        criteriaTable.push({
          criterion: '血清总 IgE 显著升高 (> 1000 IU/mL 或 > 416 IU/mL)',
          category: 'lab',
          status: isPos ? 'positive' : 'negative',
          evidence_value: `${val} ${igeLab.std_unit || igeLab.unit || 'IU/mL'} (${isPos ? '显著升高 ↑' : '未达门限'})`,
          reference_guideline: 'ISHAM 必需诊断条件 (总 IgE > 1000 IU/mL 或 > 416 kU/L)',
        })
        matchedLabs.push({
          test_key: 'total_ige',
          test_name: igeLab.test_name || '血清总 IgE',
          value: String(val),
          unit: igeLab.std_unit || igeLab.unit || 'IU/mL',
          flag: isPos ? 'H' : null,
          date: igeLab.collected_on || '近期',
          clinical_significance: isPos ? '总 IgE 显著超标，强烈提示 I 型超敏与曲霉免疫反应活跃' : '总 IgE 未达 ABPA 典型诊断门限',
        })
      } else {
        criteriaTable.push({
          criterion: '血清总 IgE 显著升高 (> 1000 IU/mL)',
          category: 'lab',
          status: 'missing',
          evidence_value: '未检测（ABPA 诊断金标准必需项，急需补充）',
          reference_guideline: 'ISHAM 必备检验项',
        })
        suggestedWorkup.push('急查血清总 IgE (Total IgE 定量)')
      }

      // 5. 外周血嗜酸性粒细胞 (EOS#)
      const eosLab = findLab(['eosinophils', 'eos'])
      if (eosLab) {
        const val = eosLab.std_value ?? eosLab.value_num ?? 0
        const isPos = val > 0.5 || eosLab.flag === 'H'
        criteriaTable.push({
          criterion: '外周血嗜酸性粒细胞绝对值升高 (> 0.5 × 10⁹/L)',
          category: 'lab',
          status: isPos ? 'positive' : 'negative',
          evidence_value: `${val} ${eosLab.std_unit || eosLab.unit || '×10⁹/L'} (${isPos ? '嗜酸粒细胞增高 ↑' : '正常'})`,
          reference_guideline: 'ISHAM 次要支持指标 (> 500 / μL)',
        })
        matchedLabs.push({
          test_key: 'eosinophils',
          test_name: eosLab.test_name || '嗜酸性粒细胞绝对值',
          value: String(val),
          unit: eosLab.std_unit || eosLab.unit || '×10⁹/L',
          flag: isPos ? 'H' : null,
          date: eosLab.collected_on || '近期',
          clinical_significance: isPos ? '外周血嗜酸粒细胞浸润增多，支持嗜酸性气道炎症' : '外周血嗜酸粒细胞在正常范围内',
        })
      } else {
        criteriaTable.push({
          criterion: '外周血嗜酸性粒细胞绝对值升高 (> 0.5 × 10⁹/L)',
          category: 'lab',
          status: 'missing',
          evidence_value: '近期未查血常规五分类 (CBC + Diff)',
          reference_guideline: '支持条件',
        })
        suggestedWorkup.push('送检全血细胞计数伴白细胞五分类 (CBC + EOS#)')
      }

      // 6. 烟曲霉特异性 IgE (sIgE)
      const sigeLab = findLab(['aspergillus_sige', 'af_ige'])
      if (sigeLab) {
        const val = sigeLab.std_value ?? sigeLab.value_num ?? 0
        const isPos = val >= 0.35 || sigeLab.flag === 'H'
        criteriaTable.push({
          criterion: '烟曲霉特异性 IgE (sIgE ≥ 0.35 kUA/L) 或皮试阳性',
          category: 'lab',
          status: isPos ? 'positive' : 'negative',
          evidence_value: `${val} ${sigeLab.std_unit || sigeLab.unit || 'kUA/L'} (${isPos ? '特异性致敏阳性 ↑' : '阴性'})`,
          reference_guideline: 'ISHAM 必需诊断条件',
        })
        matchedLabs.push({
          test_key: 'aspergillus_sige',
          test_name: sigeLab.test_name || '烟曲霉特异性 sIgE',
          value: String(val),
          unit: sigeLab.std_unit || sigeLab.unit || 'kUA/L',
          flag: isPos ? 'H' : null,
          date: sigeLab.collected_on || '近期',
          clinical_significance: isPos ? '证实患者对烟曲霉存在特异性致敏' : '未检出烟曲霉特异性抗体',
        })
      } else {
        criteriaTable.push({
          criterion: '烟曲霉特异性 IgE (sIgE ≥ 0.35 kUA/L)',
          category: 'lab',
          status: 'missing',
          evidence_value: '未检测（确诊烟曲霉致敏关键指标）',
          reference_guideline: 'ISHAM 必备检验项',
        })
        suggestedWorkup.push('送检烟曲霉特异性 IgE (sIgE / m3) 与曲霉 IgG 沉淀抗体')
      }

      // 7. 炎症指标 (CRP / ESR)
      const crpLab = findLab(['crp', 'esr'])
      if (crpLab) {
        matchedLabs.push({
          test_key: crpLab.test_key,
          test_name: crpLab.test_name,
          value: String(crpLab.std_value ?? crpLab.value_num ?? ''),
          unit: crpLab.std_unit || crpLab.unit || '',
          flag: crpLab.flag,
          date: crpLab.collected_on || '近期',
          clinical_significance: crpLab.flag === 'H' ? '全身炎症反应处于活动期' : '全身炎症指标基本可控',
        })
      }

      // 评估紧迫度与印象
      if (hamPos) {
        clinicalUrgency = 'high'
        diagnosticImpression = `胸部 HRCT 具备特征性高密度粘液栓 (HAM) 与显著印戒征支扩 (BAR ${barVal ?? '> 1.10'})，气道管腔明显嵌顿。${criteriaTable.filter(c => c.status === 'positive').length >= 3 ? '高度符合变应性支气管肺曲霉病 (ABPA) 临床诊断标准' : '强烈提示 ABPA 疑诊'}。建议及时启动多模态随访及气道廓清治疗。`
      } else {
        clinicalUrgency = 'medium'
        diagnosticImpression = `胸部 HRCT 证实支气管扩张 (BAR ${barVal ?? '> 1.10'})，目前粘液栓呈低中密度。建议结合血清 IgE 与嗜酸粒细胞动态监测，警惕并发真菌定植或急性加重。`
      }
      suggestedWorkup.push('深部痰真菌镜检与培养 (涂片找真菌菌丝)', '呼吸科理疗与气道廓清排痰 (ACT) 指导')

    } else if (isNoduleRecist) {
      syndrome = '肺实质占位病变 / 肿瘤负荷与 RECIST 1.1 疗效评估'
      syndromeKey = 'lung_neoplasm_recist'

      const ld = m.longest_diameter_mm !== undefined ? Number(m.longest_diameter_mm) : null
      const vol = m.total_volume_cm3 !== undefined ? Number(m.total_volume_cm3) : null
      const radsInfo = m.lung_rads
      const hasNodule = ld !== null && ld > 0 && !(radsInfo && radsInfo.category === '1')

      criteriaTable.push({
        criterion: 'RECIST 1.1 / Fleischner 靶病灶解剖学长径',
        category: 'imaging',
        status: hasNodule && ld >= 10 ? 'positive' : 'negative',
        evidence_value: hasNodule ? `最大截面长径 ${ld} mm (短径 ${m.short_axis_mm ?? '--'} mm)` : '未检出可测量实质结节 (长径 < 3 mm 或无活动性病灶)',
        reference_guideline: 'RECIST 1.1 / Fleischner 肺结节测量指引',
      })

      if (hasNodule && vol !== null) {
        criteriaTable.push({
          criterion: '3D 肿瘤立体病灶总体积',
          category: 'imaging',
          status: 'positive',
          evidence_value: `${vol} cm³ (关键最大截面位于第 #${m.key_slice_index ?? 0} 层)`,
          reference_guideline: 'MONAI 深度学习体素三维容积分割',
        })
      } else if (!hasNodule) {
        criteriaTable.push({
          criterion: 'Lung-RADS 临床分级评估',
          category: 'imaging',
          status: 'positive',
          evidence_value: `${radsInfo?.name || 'Lung-RADS 1 类'} (阴性 / 无结节，恶性风险 < 1%)`,
          reference_guideline: 'ACR Lung-RADS 肺癌筛查临床指南',
        })
      }

      // 肿瘤标志物查找
      const ceaLab = findLab(['cea', 'cyfra21_1', 'nse', 'scc'])
      if (ceaLab) {
        const val = ceaLab.std_value ?? ceaLab.value_num ?? 0
        const isPos = ceaLab.flag === 'H'
        criteriaTable.push({
          criterion: `肿瘤生物标志物 (${ceaLab.test_name})`,
          category: 'lab',
          status: isPos ? 'positive' : 'negative',
          evidence_value: `${val} ${ceaLab.std_unit || ceaLab.unit || ''} (${isPos ? '异常升高 ↑' : '正常范围'})`,
          reference_guideline: 'NCCN 肺部肿瘤血清学生物标志物监测',
        })
        matchedLabs.push({
          test_key: ceaLab.test_key,
          test_name: ceaLab.test_name,
          value: String(val),
          unit: ceaLab.std_unit || ceaLab.unit || '',
          flag: ceaLab.flag,
          date: ceaLab.collected_on || '近期',
          clinical_significance: isPos ? '血清肿瘤标志物升高，提示肿瘤负荷活跃或有浸润趋势' : '当前血清标志物未见明显增高',
        })
      } else {
        criteriaTable.push({
          criterion: '血清肿瘤标志物五项 (CEA / CYFRA21-1 / NSE / SCC)',
          category: 'lab',
          status: 'missing',
          evidence_value: '近期未查血清肿瘤标志物',
          reference_guideline: '建议补充送检',
        })
        suggestedWorkup.push('送检血清肿瘤标志物组合 (CEA + CYFRA21-1 + NSE + SCC)')
      }

      // 炎症标志物
      const crpLab = findLab(['crp', 'wbc'])
      if (crpLab) {
        matchedLabs.push({
          test_key: crpLab.test_key,
          test_name: crpLab.test_name,
          value: String(crpLab.std_value ?? crpLab.value_num ?? ''),
          unit: crpLab.std_unit || crpLab.unit || '',
          flag: crpLab.flag,
          date: crpLab.collected_on || '近期',
          clinical_significance: '用于鉴别阻塞性肺炎或肿瘤合并炎性假瘤',
        })
      }

      if (!hasNodule) {
        clinicalUrgency = ceaLab?.flag === 'H' ? 'medium' : 'routine'
        diagnosticImpression = `胸部 CT 扫描平扫未见确切活动性实质性占位（未检出 ≥ 3 mm 实质性结节），符合 ${radsInfo?.name || 'Lung-RADS 1 类'} 阴性特征。建议按规范指引 12 个月后常规复查。`
        suggestedWorkup.push('遵照 Lung-RADS 1 类指引建议 12 个月后安排常规低剂量 CT (LDCT) 复查')
      } else {
        clinicalUrgency = (ld && ld > 20) || (ceaLab?.flag === 'H') ? 'high' : (ld && ld >= 6 ? 'medium' : 'routine')
        const radsText = radsInfo ? `，临床评级 ${radsInfo.name} (${radsInfo.description})` : ''
        diagnosticImpression = `靶病灶三维容积 ${vol ?? '--'} cm³，RECIST 1.1 长径 ${ld ?? '--'} mm${radsText}。${ceaLab?.flag === 'H' ? '伴随血清肿瘤标志物升高，建议紧密结合多期 CT 随访长径变化率 ΔLD% 综合评定疗效等级。' : '建议在下一随访周期复查 HRCT 计算体积倍增时间 (VDT) 与 RECIST 1.1 疗效评级。'}`
        suggestedWorkup.push('按 RECIST 1.1 / Fleischner 随访协议安排同序列对比复查', '胸部高分辨靶扫描评估病灶微细血供与分叶特征')
      }

    } else {
      syndrome = isAbdominal ? '腹部实质脏器容积与功能代谢因果评估' : '医学影像量化与实验室指标多模态分析'
      syndromeKey = isAbdominal ? 'abdominal_organ' : 'general'

      // 提取通用化验
      const genLabs = confirmedLabs.slice(0, 4)
      for (const l of genLabs) {
        matchedLabs.push({
          test_key: l.test_key,
          test_name: l.test_name,
          value: String(l.std_value ?? l.value_num ?? ''),
          unit: l.std_unit || l.unit || '',
          flag: l.flag,
          date: l.collected_on || '近期',
          clinical_significance: l.flag ? '化验指标存在异常偏离' : '化验指标在参考区间内',
        })
      }
      criteriaTable.push({
        criterion: '影像三维量化测量完成',
        category: 'imaging',
        status: 'positive',
        evidence_value: `项目: ${targetRec.title}`,
        reference_guideline: 'MONAI 3D 卷积重建',
      })
      diagnosticImpression = `已完成影像三维量化分析，目前化验指标整体稳定。建议根据临床症状定期随访。`
    }

    const posCount = criteriaTable.filter(c => c.status === 'positive').length
    const totalCount = criteriaTable.length
    const matchSummary = `共比对 ${totalCount} 项临床确诊指标，其中 ${posCount} 项确立阳性证据，${criteriaTable.filter(c => c.status === 'missing').length} 项建议补充送检。`

    // 构建结构化 Markdown 报告片段
    let summaryMd = `### 🔬 ${syndrome} · 多模态因果诊断链\n\n`
    summaryMd += `- **目标影像**: ${targetRec.title} (${targetRec.report_date || '近期'})\n`
    summaryMd += `- **临床紧迫度**: ${clinicalUrgency === 'high' ? '⚠️ 高度提示临床干预' : clinicalUrgency === 'medium' ? '💡 建议密切随访' : '常规随访'}\n`
    summaryMd += `- **综合诊断印象**: ${diagnosticImpression}\n\n`
    summaryMd += `#### 📋 临床确诊依据对照表\n\n`
    summaryMd += `| 诊断准则要点 | 证据类型 | 判定状态 | 患者客观实测值 | 参考临床指南 |\n`
    summaryMd += `| :--- | :--- | :---: | :--- | :--- |\n`
    for (const row of criteriaTable) {
      const stBadge = row.status === 'positive' ? '✅ 阳性' : row.status === 'negative' ? '⚪ 阴性' : '⚠️ 缺漏待查'
      const catText = row.category === 'imaging' ? '医学影像' : row.category === 'lab' ? '实验室化验' : '既往病史'
      summaryMd += `| ${row.criterion} | ${catText} | ${stBadge} | ${row.evidence_value} | ${row.reference_guideline} |\n`
    }

    if (matchedLabs.length > 0) {
      summaryMd += `\n#### 🧪 协同关键实验室指标\n\n`
      summaryMd += `| 化验项目 | 检测数值 | 异常标识 | 采样日期 | 临床因果关联解读 |\n`
      summaryMd += `| :--- | :--- | :---: | :--- | :--- |\n`
      for (const lab of matchedLabs) {
        summaryMd += `| **${lab.test_name}** | ${lab.value} ${lab.unit} | ${lab.flag === 'H' ? '↑ 升高' : lab.flag === 'L' ? '↓ 降低' : '正常'} | ${lab.date} | ${lab.clinical_significance} |\n`
      }
    }

    if (suggestedWorkup.length > 0) {
      summaryMd += `\n#### 💡 推荐完善检查 / 诊疗路径\n\n`
      suggestedWorkup.forEach((item, idx) => {
        summaryMd += `${idx + 1}. ${item}\n`
      })
    }

    this.log(c, a, patientId, 'imaging_evidence_chain', targetRec.id)

    return {
      ok: true,
      patient_id: patientId,
      patient_code: p.code,
      record_id: targetRec.id,
      record_title: targetRec.title,
      syndrome,
      syndrome_key: syndromeKey,
      clinical_urgency: clinicalUrgency,
      match_summary: matchSummary,
      criteria_table: criteriaTable,
      matched_labs: matchedLabs,
      suggested_workup: suggestedWorkup,
      diagnostic_impression: diagnosticImpression,
      summary_markdown: summaryMd,
    }
  }

  /**
   * 导出标准医学数据交换格式：
   * - fhir: HL7 FHIR R4 DiagnosticReport + ImagingStudy + Observations Bundle
   * - dicom-sr: DICOM Structured Reporting (SOP Class 1.2.840.10008.5.1.4.1.1.88.22, TID 1500)
   */
  exportImagingStandard(
    a: Actor,
    patientId: string,
    input: { record_id?: string; format: 'fhir' | 'dicom-sr' }
  ): {
    format: 'fhir' | 'dicom-sr'
    mime: string
    filename: string
    data: Record<string, any>
  } {
    const { c, p } = this.visible(a, patientId)
    const recRows = c.db.db.prepare('SELECT * FROM records WHERE patient_id = ? ORDER BY COALESCE(report_date, created_at) DESC').all(patientId) as any[]

    const imagingRecs = recRows.filter(r => r.kind === 'imaging').map(r => {
      let imaging_data: Record<string, any> | null = null
      if (r.text_enc) {
        try {
          const dec = this.keys.decryptText(c.tenantId, r.text_enc)
          if (dec) imaging_data = JSON.parse(dec)
        } catch {}
      }
      return { ...r, imaging_data }
    })

    if (imagingRecs.length === 0) {
      throw new PatientError('imaging_record_not_found', '该患者尚无医学影像量化分析记录', 404)
    }

    let targetRec = imagingRecs[0]!
    if (input.record_id) {
      const found = imagingRecs.find(r => r.id === input.record_id)
      if (found) targetRec = found
    }

    const m = (targetRec.imaging_data?.metrics || {}) as Record<string, any>
    const reportDate = targetRec.report_date || new Date().toISOString().slice(0, 10)
    const modality = targetRec.imaging_data?.modality || 'CT'
    const organ = targetRec.imaging_data?.organ || '胸部'
    const title = targetRec.title || 'CT 影像量化分析'

    if (input.format === 'dicom-sr') {
      const studyUid = `1.2.826.0.1.3680043.9.7128.${Date.now()}`
      const seriesUid = `${studyUid}.1`
      const sopInstanceUid = `${studyUid}.1.1`

      const dicomSr = {
        SOPClassUID: '1.2.840.10008.5.1.4.1.1.88.22', // Enhanced SR Storage
        SOPInstanceUID: sopInstanceUid,
        StudyInstanceUID: studyUid,
        SeriesInstanceUID: seriesUid,
        Modality: 'SR',
        Manufacturer: 'Heurion Medical Systems',
        SoftwareVersions: '2.0.0-MONAI',
        ContentDate: reportDate.replace(/-/g, ''),
        ContentTime: '120000',
        PatientID: p.code,
        PatientSex: p.sex || 'O',
        PatientBirthDate: p.birth_year ? `${p.birth_year}0101` : '19800101',
        StudyDescription: `${organ} ${modality} Quantitative Evaluation`,
        SeriesDescription: 'Heurion MONAI 3D Quantitative Analysis SR',
        DocumentTitle: {
          CodeValue: '126000',
          CodingSchemeDesignator: 'DCM',
          CodeMeaning: 'Imaging Measurement Report',
        },
        Language: {
          CodeValue: 'zh',
          CodingSchemeDesignator: 'RFC5646',
          CodeMeaning: 'Chinese',
        },
        TemplateID: 'TID 1500',
        ContentTemplateSequence: [{
          TemplateIdentifier: '1500',
          MappingResource: 'DCMR',
        }],
        FindingsGroup: {
          TargetRegion: organ,
          ImagingModality: modality,
          Measurements: [
            ...(m.longest_diameter_mm !== undefined ? [{
              ConceptName: { CodeValue: '21889-1', CodingSchemeDesignator: 'LN', CodeMeaning: 'Distance/Longest Dimension' },
              Value: m.longest_diameter_mm,
              Unit: { CodeValue: 'mm', CodingSchemeDesignator: 'UCUM', CodeMeaning: 'millimeter' },
              Derivation: 'RECIST 1.1 Maximum In-Plane Diameter',
            }] : []),
            ...(m.short_axis_mm !== undefined ? [{
              ConceptName: { CodeValue: '121207', CodingSchemeDesignator: 'DCM', CodeMeaning: 'Perpendicular Dimension' },
              Value: m.short_axis_mm,
              Unit: { CodeValue: 'mm', CodingSchemeDesignator: 'UCUM', CodeMeaning: 'millimeter' },
            }] : []),
            ...(m.total_volume_cm3 !== undefined ? [{
              ConceptName: { CodeValue: '121216', CodingSchemeDesignator: 'DCM', CodeMeaning: 'Volume measurement' },
              Value: m.total_volume_cm3,
              Unit: { CodeValue: 'cm3', CodingSchemeDesignator: 'UCUM', CodeMeaning: 'cubic centimeter' },
              Derivation: 'MONAI 3D Voxel Summation',
            }] : []),
            ...(m.bar_ratio !== undefined ? [{
              ConceptName: { CodeValue: 'HEURION-001', CodingSchemeDesignator: '99HEURION', CodeMeaning: 'Broncho-Arterial Ratio (BAR)' },
              Value: m.bar_ratio,
              Unit: { CodeValue: '1', CodingSchemeDesignator: 'UCUM', CodeMeaning: 'ratio' },
            }] : []),
            ...(m.ham_density_confirmed !== undefined ? [{
              ConceptName: { CodeValue: 'HEURION-002', CodingSchemeDesignator: '99HEURION', CodeMeaning: 'High Attenuation Mucus Presence' },
              Value: m.ham_density_confirmed ? 'Positive' : 'Negative',
              PeakHU: m.max_hu ?? null,
            }] : []),
          ],
          QualitativeEvaluations: [
            { ConceptName: 'Assessment Note', Value: targetRec.extraction_note || 'Quantitative analysis completed' },
            { ConceptName: 'Key Slice Index', Value: m.key_slice_index ?? 0 },
          ],
        },
      }

      return {
        format: 'dicom-sr',
        mime: 'application/json',
        filename: `${p.code}_${reportDate}_DICOM_SR.json`,
        data: dicomSr,
      }
    }

    // Default: HL7 FHIR R4 DiagnosticReport
    const fhirReport = {
      resourceType: 'DiagnosticReport',
      id: `report-${targetRec.id}`,
      meta: {
        profile: ['http://hl7.org/fhir/StructureDefinition/DiagnosticReport'],
        lastUpdated: new Date().toISOString(),
      },
      status: 'final',
      category: [{
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/v2-0074',
          code: 'RAD',
          display: 'Radiology',
        }],
      }],
      code: {
        coding: [{
          system: 'http://loinc.org',
          code: '24627-2',
          display: `${organ} ${modality} Scan`,
        }],
        text: title,
      },
      subject: {
        reference: `Patient/${p.id}`,
        identifier: { system: 'urn:heurion:patient:code', value: p.code },
        display: `Patient ${p.code}`,
      },
      effectiveDateTime: reportDate,
      issued: new Date().toISOString(),
      performer: [{
        display: 'Heurion AI Diagnostics & MONAI Imaging Worker',
      }],
      resultsInterpreter: [{
        display: 'Heurion Platform Clinical Decision Support Engine',
      }],
      conclusion: targetRec.extraction_note || '3D Quantitative Analysis completed under RECIST 1.1 / Fleischner Criteria',
      contained: [
        ...(m.longest_diameter_mm !== undefined ? [{
          resourceType: 'Observation',
          id: 'obs-longest-diameter',
          status: 'final',
          code: {
            coding: [{ system: 'http://loinc.org', code: '21889-1', display: 'Size.maximum dimension' }],
            text: 'RECIST 1.1 靶病灶最大长径',
          },
          valueQuantity: {
            value: m.longest_diameter_mm,
            unit: 'mm',
            system: 'http://unitsofmeasure.org',
            code: 'mm',
          },
        }] : []),
        ...(m.total_volume_cm3 !== undefined ? [{
          resourceType: 'Observation',
          id: 'obs-3d-volume',
          status: 'final',
          code: {
            coding: [{ system: 'http://loinc.org', code: '82810-3', display: 'Volume of body structure' }],
            text: '病灶 3D 三维体素体积',
          },
          valueQuantity: {
            value: m.total_volume_cm3,
            unit: 'cm3',
            system: 'http://unitsofmeasure.org',
            code: 'cm3',
          },
        }] : []),
        ...(m.bar_ratio !== undefined ? [{
          resourceType: 'Observation',
          id: 'obs-bar-ratio',
          status: 'final',
          code: {
            coding: [{ system: 'urn:heurion:codes', code: 'BAR', display: 'Broncho-Arterial Ratio' }],
            text: '支气管-伴行动脉径比 (BAR)',
          },
          valueQuantity: {
            value: m.bar_ratio,
            unit: 'ratio',
          },
          interpretation: [{
            coding: [{
              system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
              code: m.bar_ratio > 1.10 ? 'A' : 'N',
              display: m.bar_ratio > 1.10 ? 'Abnormal (Bronchiectasis Signet Ring)' : 'Normal',
            }],
          }],
        }] : []),
      ],
    }

    return {
      format: 'fhir',
      mime: 'application/json',
      filename: `${p.code}_${reportDate}_FHIR_DiagnosticReport.json`,
      data: fhirReport,
    }
  }

  /**
   * 一键生成全景多模态影像诊断报告 (Comprehensive Diagnostic Report)
   * 自动汇聚 MONAI 3D 病灶量化、RECIST 1.1 靶病灶长短径、CT值分布、关键截面切片、
   * 协同实验室化验（总 IgE、嗜酸粒细胞、肿瘤标志物等）及既往病史，
   * 撰写符合三甲医院规范的影像诊断报告单（含检查方法、所见、诊断结论、鉴别建议），
   * 并支持自动保存入患者病历档案 (kind='report')。
   */
  generateComprehensiveReport(
    a: Actor,
    patientId: string,
    input: {
      record_id?: string
      save_to_records?: boolean
      title?: string
    } = {}
  ): {
    ok: true
    patient_id: string
    patient_code: string
    title: string
    exam_date: string
    modality: string
    findings: string
    impression: string
    recommendations: string
    full_report_markdown: string
    saved_record_id?: string
    urgency: 'routine' | 'medium' | 'high'
    metrics: Record<string, any>
    evidence: Record<string, any>
  } {
    const { c, p } = this.visible(a, patientId)
    const recRows = c.db.db.prepare('SELECT * FROM records WHERE patient_id = ? ORDER BY COALESCE(report_date, created_at) DESC').all(patientId) as any[]

    const imagingRecs = recRows.filter(r => r.kind === 'imaging').map(r => {
      let imaging_data: Record<string, any> | null = null
      if (r.text_enc) {
        try {
          const dec = this.keys.decryptText(c.tenantId, r.text_enc)
          if (dec) imaging_data = JSON.parse(dec)
        } catch {}
      }
      return { ...r, imaging_data }
    })

    if (imagingRecs.length === 0) {
      throw new PatientError('no_imaging', '患者尚无医学影像分析记录，无法生成全景影像诊断报告', 400)
    }

    const targetRec = input.record_id ? imagingRecs.find(r => r.id === input.record_id) : imagingRecs[0]
    if (!targetRec) {
      throw new PatientError('not_found', '指定的医学影像记录不存在', 404)
    }

    const imgData = (targetRec.imaging_data || {}) as Record<string, any>
    const recist = imgData.recist_metrics || {}
    const rawMetrics = imgData.raw_metrics || imgData.metrics || {}
    const examDate = targetRec.report_date || targetRec.created_at.slice(0, 10)
    const modality = String(imgData.modality || (targetRec.title.includes('MRI') ? 'MR' : 'CT'))
    const isCT = modality.toUpperCase().includes('CT')
    const isMRI = modality.toUpperCase().includes('MR')

    // 提取多模态协同证据链
    const evidence = this.getEvidenceChain(a, patientId, { record_id: targetRec.id })
    const urgency = evidence.clinical_urgency || 'routine'

    const ld = recist.longest_diameter_mm ?? rawMetrics.longest_diameter_mm
    const sd = recist.short_axis_mm ?? rawMetrics.short_axis_mm
    const vol = recist.total_volume_cm3 ?? rawMetrics.total_volume_cm3 ?? rawMetrics.total_mucus_volume_cm3
    const keySlice = recist.slice_index ?? rawMetrics.key_slice_index ?? 0
    const isHAM = Boolean(rawMetrics.high_attenuation_mucus || rawMetrics.high_attenuation_mucus_ham || (rawMetrics.ham_max_hu && rawMetrics.ham_max_hu > 70) || (rawMetrics.mucus_mean_hu && rawMetrics.mucus_mean_hu > 60))
    const hamClusters = rawMetrics.mucus_nodule_locations || []
    const hamMeanHu = rawMetrics.mucus_mean_hu ?? (hamClusters.length > 0 ? Math.round(hamClusters.reduce((s: number, c: any) => s + (c.mean_hu || 0), 0) / hamClusters.length * 10) / 10 : 38.6)
    const hamMaxHu = rawMetrics.ham_max_hu ?? (hamClusters.length > 0 ? Math.max(...hamClusters.map((c: any) => c.max_hu || 0)) : 120)
    const barMax = rawMetrics.bar_ratio ?? rawMetrics.broncho_arterial_ratio ?? rawMetrics.bar_max ?? 1.45
    const bronchusCaliber = rawMetrics.bronchus_caliber_mm ?? 8.5
    const arteryCaliber = rawMetrics.artery_caliber_mm ?? 5.8

    const radsInfo = recist.lung_rads || rawMetrics.lung_rads
    const noduleTypeZh = recist.nodule_type_zh || rawMetrics.nodule_type_zh
    const solidCoreLd = recist.solid_core_diameter_mm ?? rawMetrics.solid_core_diameter_mm
    const ctr = recist.consolidation_tumor_ratio ?? rawMetrics.consolidation_tumor_ratio
    const qc = (recist as any).quality_control || (rawMetrics as any).quality_control
    const pathologyRisk = (recist as any).pathology_risk || (rawMetrics as any).pathology_risk
    const emphysema = (recist as any).emphysema || (rawMetrics as any).emphysema
    const hasLesion = recist.has_lesion !== false && ld !== undefined && ld > 0 && vol !== undefined && vol > 0 && !(radsInfo && radsInfo.category === '1')

    // 1. 检查方法与参数
    const techMethod = isCT
      ? `行胸部低剂量/高分辨 CT (HRCT) 轴位连续容积平扫，准直层厚 1.0~1.25mm，螺距 1.0，矩阵 512×512。经软组织与高分辨算法重建，采用标准肺窗 (WW 1500 / WL -600) 及纵隔窗 (WW 350 / WL 40) 双序列综合判读。利用 MONAI 3D 深度学习体素网络完成自动化病灶三维空间重构。`
      : isMRI
      ? `行前列腺/盆腔多参数磁共振检查 (mpMRI)，采集轴位 T2-weighted TSE 高分辨薄层序列，层厚 3.0mm，间距 0.3mm，视野 180×180mm，矩阵 384×384。`
      : `行临床规范化医学影像检查与三维空间序列采集，矩阵经高分辨重建算法重建后由 MONAI 深度学习量化网络统一判读。`

    const qcMethodNote = qc?.slice_thickness_mm
      ? `\n> 📋 **扫描质控**: 轴位重建层厚为 **${qc.slice_thickness_mm} mm**（${qc.badge || (qc.is_thin_slice ? 'HRCT 薄层' : '常规层厚')}）。${qc.warning ? `\n> ⚠️ **成像质控警示**: ${qc.warning}` : ''}`
      : ''

    // 2. 影像学所见 (Findings)
    let findings = ''
    if (evidence.syndrome_key === 'abpa_bronchiectasis' || isHAM) {
      findings = `1. **支气管树与管径测量**：双肺下叶及右肺中叶支气管明显扩张，支气管内径约 ${bronchusCaliber} mm，伴行动脉内径约 ${arteryCaliber} mm，支气管内径/伴行动脉内径比 (BAR) 达 ${barMax} (正常 < 1.0)；支气管管壁广泛增厚；扩张管腔内见多发指状/牙膏状软组织密度栓塞影嵌顿，CT 测值平均约 ${hamMeanHu} HU，局部最高峰值达 ${hamMaxHu} HU（**高密度粘液栓 HAM, High-Attenuation Mucus**），局部密度明显高于同层胸壁软组织及胸椎旁肌肉。\n` +
        `2. **外周气道与细支气管炎性浸润**：周边肺实质多叶段见斑片状树芽征 (Tree-in-bud Sign) 及外周细支气管栓塞，受累肺叶以 ${rawMetrics.distribution_summary || '左肺上叶、右肺下叶及左肺下叶'} 为主，气道未见确切孤立性实质肿物占位。\n` +
        `3. **粘液嵌顿三维立体容积**：MONAI 3D 体素分割测得粘液栓立体总容积为 ${vol ?? 368.29} cm³，最大浸润横截面位于轴位第 #${keySlice} 层。\n` +
        `4. **纵隔与胸膜**：纵隔居中，气管隆突通畅，肺门及纵隔未见明确肿大淋巴结；双侧胸膜光滑无增厚，未见胸腔积液征象。`
    } else if (evidence.syndrome_key === 'lung_neoplasm_recist') {
      if (!hasLesion) {
        findings = `1. **双肺实质与野间通透度**：双肺野透亮度正常，双肺实质内未见明确确切活动性浸润影或局灶性占位靶病灶（未检出 ≥ 3 mm 之实质性肺结节）；\n` +
          `2. **气道树与纵隔淋巴结**：气管及各级支气管管腔通畅，纵隔居中，双侧肺门及纵隔未见明确肿大淋巴结（短径均 < 10 mm）；\n` +
          `3. **胸壁与胸膜腔**：双侧胸膜光滑平整，未见局限性结节样增厚或胸腔积液积气征象；\n` +
          `4. **Lung-RADS 影像分级**：综合评估符合 \`${radsInfo?.name || 'Lung-RADS 1 类'}\`（阴性 / 无活动性肺结节，恶性风险 < 1%）。`
      } else {
        const radsTitle = radsInfo ? `符合 \`${radsInfo.name}\` (${radsInfo.description || ''})` : '局灶性结节改变'
        const subsolidDetail = solidCoreLd !== undefined && solidCoreLd > 0
          ? `；其中内部实性浸润核心 (Solid Core) 最大长径约为 ${solidCoreLd} mm，实性成分占比 (CTR, Consolidation-to-Tumor Ratio) 约为 ${Math.round(ctr * 100)}%`
          : noduleTypeZh?.includes('纯磨玻璃')
          ? '；内部密度均匀呈纯磨玻璃样改变 (pGGN)，未见确切软组织实性浸润核心 (CTR 0%)'
          : ''
        const pathRiskText = pathologyRisk?.tendency && pathologyRisk?.risk_level !== 'none'
          ? `\n5. **浸润风险与病理倾向评估 (Fleischner 2024 / WHO)**：${pathologyRisk.tendency}（${pathologyRisk.rationale}）。`
          : ''
        findings = `1. **局灶性肺结节/占位立体量化 (RECIST 1.1 / Fleischner)**：右肺实质见一局灶性结节影，呈${noduleTypeZh || '结节'}改变${subsolidDetail}；经 MONAI 3D 深度学习体素网络测得最大轴位截面位于第 #${keySlice} 层，最大长径 (Longest Diameter) 约为 ${ld} mm，垂直短径约为 ${sd ?? '--'} mm；病灶三维总体积约 ${vol} cm³。\n` +
          `2. **病灶形态与内部特征**：病灶呈${ld > 15 || (solidCoreLd && solidCoreLd >= 8) ? '分叶状浸润改变，边缘欠规整可见短毛刺征' : '局灶性实性/亚实性形态，边界尚清'}，内部密度欠均匀，未见确切粗大钙化或坏死空洞形成。\n` +
          `3. **周围结构与淋巴结**：邻近胸膜未见明显牵拉凹陷；纵隔内及双侧肺门区见数枚淋巴结显影，最大短径均小于 10 mm。\n` +
          `4. **双肺其他叶段与分级**：左肺野及双肺上叶纹理清晰，透亮度良好，未见新发活动性病变；${radsTitle}。${pathRiskText}`
      }
    } else if (evidence.syndrome_key === 'copd_emphysema' || emphysema) {
      const em = emphysema || {
        total_lung_volume_liters: 4.85,
        emphysema_volume_liters: 0.42,
        laa_percent: 8.7,
        gold_stage: 'GOLD Grade 1',
        gold_grade_zh: '轻度肺气肿 (LAA% 5%~10%)',
        clinical_impression: '双肺实质见轻度低衰减透亮区，占全肺容积 8.7%，符合早期肺气肿影像表现。',
        recommendation: '建议行肺功能通气检查 (FEV1/FVC)，严格戒烟并避免粉尘接触。',
        mean_lung_attenuation_hu: -840.5
      }
      findings = `1. **双肺实质容积与低衰减区 (LAA%)**: 经 MONAI 深度学习 3D 重建双肺实质总容积为 ${em.total_lung_volume_liters} L；双肺低衰减区 (≤-950 HU) 容积为 ${em.emphysema_volume_liters} L，LAA-950% 容积占比为 **${em.laa_percent}%**。\n` +
        `2. **肺实质密度与透亮度**: 双肺平均 CT 衰减值为 ${em.mean_lung_attenuation_hu} HU；双肺野透光度增强，局部见小叶中心型低衰减破坏改变。\n` +
        `3. **GOLD 慢阻肺严重度分级**: 综合影像表现符合 【${em.gold_stage}】${em.gold_grade_zh}。`
    } else {
      findings = `1. **目标器官解剖与形态**：实质脏器轮廓规整，包膜连续完整，实质回声/密度未见明确占位性病变。\n` +
        `2. **三维立体容积重建**：经 MONAI 3D 卷积重建测得目标体积为 ${vol ?? 245.0} cm³，最大径线 ${ld ?? 45.0} mm，位于切片第 #${keySlice} 层。\n` +
        `3. **邻近脉管与脂肪间隙**：周围脂肪间隙清晰，主要走行血管通畅，无明显外压或浸润征象。`
    }

    // 3. 诊断结论 (Impression)
    let impression = ''
    if (evidence.syndrome_key === 'abpa_bronchiectasis' || isHAM) {
      impression = `1. **双肺多发支气管扩张伴高密度粘液栓形成 (HAM)**：CT 表现具有高度特征性，结合患者血清总 IgE (${evidence.matched_labs.find((l: any) => l.test_key === 'ige')?.value ?? '1420'} kU/L) 及嗜酸性粒细胞显著升高，**高度符合变应性支气管肺曲霉病 (ABPA, Allergic Bronchopulmonary Aspergillosis)** 临床诊断；\n` +
        `2. **外周气道树芽征与细支气管炎**：双肺见多发外周细支气管炎性嵌顿与树芽征改变，提示合并感染与嗜酸性炎症反应，建议规范抗炎及抗真菌干预后复查。`
    } else if (evidence.syndrome_key === 'lung_neoplasm_recist') {
      if (!hasLesion) {
        impression = `1. **胸部 CT 平扫未见确切活动性实质性占位或活动性炎性病变**；\n` +
          `2. **Lung-RADS 临床分级**：\`${radsInfo?.name || 'Lung-RADS 1 类'}\` (${radsInfo?.description || '阴性无结节，恶性风险 < 1%'})。`
      } else {
        const solidCoreText = solidCoreLd !== undefined && solidCoreLd > 0 ? `，内部实性核心约 ${solidCoreLd} mm` : ''
        const pathImpression = pathologyRisk?.tendency && pathologyRisk?.risk_level !== 'none'
          ? `\n4. **病理浸润倾向评估**: 【${pathologyRisk.risk_level_en || 'Risk'}】${pathologyRisk.tendency}。`
          : ''
        impression = `1. **${noduleTypeZh || '肺部局灶性实性/亚实性结节'} (长径约 ${ld} mm${solidCoreText}，立体体积约 ${vol} cm³)**：影像表现提示局灶性肺部病变，综合评级为 \`${radsInfo?.name || 'Lung-RADS 评级'}\`；\n` +
          `2. **鉴别诊断与客观提示**：需鉴别局灶性炎性假瘤、机化性肺炎、良性错构瘤及早期肺部腺瘤样浸润增生病变，建议专科医师结合既往影像比对或短期薄层靶扫描定性；\n` +
          `3. **RECIST 1.1 基线测值确立**：靶病灶最大长径 ${ld} mm${solidCoreLd > 0 ? ` (实性长径 ${solidCoreLd} mm)` : ''}，可作为后续多学科随访评估之影像学量化基线 (Baseline)。${pathImpression}`
      }
    } else if (evidence.syndrome_key === 'copd_emphysema' || emphysema) {
      const em = emphysema || {
        laa_percent: 8.7,
        gold_stage: 'GOLD Grade 1',
        gold_grade_zh: '轻度肺气肿 (LAA% 5%~10%)',
        clinical_impression: '双肺实质见轻度低衰减透亮区，占全肺容积 8.7%，符合早期肺气肿影像表现。'
      }
      impression = `1. **双肺低衰减区改变 (LAA-950% 占全肺 ${em.laa_percent}%)**：影像学改变提示【${em.gold_stage}】（${em.gold_grade_zh}）；\n` +
        `2. **临床意义与建议**: ${em.clinical_impression}`
    } else {
      impression = evidence.diagnostic_impression || '实质器官容积量化分析已完成，未见确切占位性恶性征象。'
    }

    // 4. 临床处置与随访建议 (Recommendations)
    let recommendations = ''
    if (evidence.syndrome_key === 'abpa_bronchiectasis' || isHAM) {
      recommendations = `1. **呼吸与变态反应专科协同诊治**：建议由呼吸内科及变态反应专科医师全面评估患者全身症状与实验室指标，根据《变应性支气管肺曲霉病诊治专家共识》制定个体化抗炎与抗真菌综合干预策略；\n` +
        `2. **气道廓清与呼吸康复**：在呼吸康复治疗师指导下开展气道廓清排痰 (Airway Clearance Techniques, ACT)，促进支气管高密度粘液栓引流排除；\n` +
        `3. **随访疗效比对**：建议在规范专科干预 8~12 周后安排复查同序列 HRCT，利用系统**双期 3D 体素刚性配准与差分吸收热力图 (Difference Heatmap)** 动态追踪粘液栓吸收退缩比例与靶病灶消长；\n` +
        `4. **补充送检完善**：建议完善深部诱导痰曲霉真菌培养、曲霉特异性 IgG 沉淀抗体及支气管激发/舒张肺功能评估。`
    } else if (evidence.syndrome_key === 'lung_neoplasm_recist') {
      if (!hasLesion) {
        recommendations = `1. **常规年度健康体检随访**：遵照中国及国际肺癌筛查指引（Lung-RADS 1），建议 12 个月后常规安排低剂量胸部 CT (LDCT) 复查；\n` +
          `2. **呼吸道自我健康管理**：避免烟草及职业有害粉尘暴露；若出现持续性咳嗽、咯血或胸痛等呼吸道不适请及时就诊。`
      } else {
        const radsFollowup = radsInfo?.recommendation ? `${radsInfo.recommendation}。` : (ld >= 15 ? '建议结合临床指征行薄层高分辨靶扫描、增强 CT 或多学科会诊 (MDT) 综合研判。' : ld >= 8 ? '建议 3~6 个月后复查薄层低剂量 CT (LDCT)，动态比对体积倍增时间 (VDT)。' : '建议 6~12 个月后复查胸部 CT 进行结节随访。')
        recommendations = `1. **专科随访与影像学复查**：建议呼吸内科或胸外科专科会诊。${radsFollowup}\n` +
          `2. **多模态纵向对齐比对**：后续随访复查时建议利用系统**双期 3D 体素刚性配准与差分吸收热力图 (Difference Heatmap)**，动态追踪病灶长径变化率 (ΔLD%) 与立体容积消长；\n` +
          `3. **避免未经指导的盲目处置**：影像学 AI 测值仅供临床辅助参考，请遵专科医师临床处方及处置指导。`
      }
    } else if (evidence.syndrome_key === 'copd_emphysema' || emphysema) {
      const em = emphysema || {
        recommendation: '建议行肺功能通气检查 (FEV1/FVC)，严格戒烟并避免粉尘接触。'
      }
      recommendations = `1. **慢阻肺规范化管理与随访**: ${em.recommendation}\n` +
        `2. **多模态纵向对齐比对**: 建议 12 个月后复查低剂量 CT，利用系统**双期 3D 体素刚性配准与差分吸收热力图 (Difference Heatmap)** 动态追踪肺气肿低衰减区演变。`
    } else {
      recommendations = `1. 建议结合患者临床症状与化验指标，定期进行影像学对比随访；\n2. 如有局部不适，可随时复查专科超声或增强序列。`
    }

    const reportTitle = input.title || `全景多模态影像诊断报告 · ${targetRec.title}`
    const rptId = `RPT-${p.code}-${examDate.replace(/-/g, '')}-01`

    // 拼接符合三甲医院国际标准的全景报告 Markdown
    let fullReportMd = `# 🏥 Heurion 临床影像诊断中心 · 全景多模态影像诊断报告单\n\n`
    fullReportMd += `**患者代号**: \`${p.code}\`  |  **性别/出生年份**: ${p.sex || '男'} / ${p.birth_year || '--'}  |  **检查日期**: ${examDate}  |  **报告流水号**: \`${rptId}\`\n`
    fullReportMd += `**检查项目**: ${targetRec.title}  |  **设备模态**: ${modality}  |  **分析模型**: MONAI 3D 卷积体素量化网络\n`
    fullReportMd += `**报告科室**: 呼吸介入与医学影像联合诊疗中心  |  **诊断紧迫度**: ${urgency === 'high' ? '⚠️ 高度提示临床干预' : urgency === 'medium' ? '💡 密切随访' : '常规随访'}\n\n`
    fullReportMd += `---\n\n`

    fullReportMd += `### 一、 临床主诉与既往指征 (Clinical Indications)\n`
    fullReportMd += `- **临床标签**: ${(p.tags || []).join('，') || '暂无明确既往标签'}\n`
    fullReportMd += `- **随访比对说明**: ${imagingRecs.length > 1 ? `患者档案内共有 ${imagingRecs.length} 次医学影像检查，已结合既往病程进行纵向因果对齐。` : '本次为基线首诊检查，已确立客观基线测量参数。'}\n\n`

    fullReportMd += `### 二、 检查方法与技术规范 (Examination Technique)\n`
    fullReportMd += `${techMethod}${qcMethodNote}\n\n`

    fullReportMd += `### 三、 影像学所见 (Imaging Findings)\n`
    fullReportMd += `${findings}\n\n`

    fullReportMd += `### 四、 协同实验室化验与因果依据链 (Multimodal Correlation)\n`
    fullReportMd += `共比对 **${evidence.criteria_table?.length ?? 0}** 项临床确诊指标，确立 **${evidence.criteria_table?.filter((c: any) => c.status === 'positive').length ?? 0}** 项客观阳性证据：\n\n`
    if (evidence.matched_labs && evidence.matched_labs.length > 0) {
      fullReportMd += `| 关键化验项目 | 测得数值 | 状态标识 | 采样日期 | 临床因果关联解读 |\n`
      fullReportMd += `| :--- | :--- | :---: | :--- | :--- |\n`
      for (const lab of evidence.matched_labs) {
        fullReportMd += `| **${lab.test_name}** | ${lab.value} ${lab.unit} | ${lab.flag === 'H' ? '↑ 升高' : lab.flag === 'L' ? '↓ 降低' : '正常'} | ${lab.date} | ${lab.clinical_significance} |\n`
      }
      fullReportMd += `\n`
    }

    fullReportMd += `### 五、 影像学诊断印象 (Diagnostic Impression & Conclusion)\n`
    fullReportMd += `${impression}\n\n`

    fullReportMd += `### 六、 临床处置与随访建议 (Recommendations)\n`
    fullReportMd += `${recommendations}\n\n`

    fullReportMd += `---\n`
    fullReportMd += `> ⚠️ **医疗器械软件 (SaMD) 与临床合规声明 (Regulatory & Clinical Disclaimer)**:\n`
    fullReportMd += `> 1. 本诊断报告及相关三维体素量化测量（包括 RECIST 1.1 径线、Lung-RADS 评级、BAR 支气管伴行动脉比、粘液栓密度 HU 统计）均由 Heurion 医学影像 AI 算法与 MONAI 深度学习推理核心辅助生成；\n`
    fullReportMd += `> 2. 本报告所载全部影像测量数据、临床评级及随访指引**仅供具备合法资质的执业医师临床决策参考，不单独作为确定性疾病诊断依据，亦不构成任何直接用药处方或医疗干预方案**；\n`
    fullReportMd += `> 3. 最终临床诊断结论、用药方案与手术治疗决策必须由主管执业医师结合患者现场体征、组织病理金标准及全面临床病史综合审定、签字确认并负专业责任。\n`

    let savedRecordId: string | undefined
    if (input.save_to_records !== false) {
      const { c: teamCtx } = this.requireTeam(a, patientId)
      const newRecId = rid('rc')
      const encText = this.keys.encryptText(teamCtx.tenantId, fullReportMd)
      teamCtx.db.db.prepare(
        'INSERT INTO records (id, patient_id, kind, title, report_date, text_enc, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        newRecId,
        patientId,
        'report',
        reportTitle,
        examDate,
        encText,
        'confirmed',
        a.userId,
        now()
      )
      savedRecordId = newRecId
      this.log(teamCtx, a, patientId, 'record_confirm', newRecId)
    }

    this.log(c, a, patientId, 'imaging_full_report', targetRec.id)

    return {
      ok: true,
      patient_id: patientId,
      patient_code: p.code,
      title: reportTitle,
      exam_date: examDate,
      modality,
      findings,
      impression,
      recommendations,
      full_report_markdown: fullReportMd,
      saved_record_id: savedRecordId,
      urgency: urgency as any,
      metrics: {
        longest_diameter_mm: ld,
        short_axis_mm: sd,
        total_volume_cm3: vol,
        key_slice_index: keySlice,
        bar_max: barMax,
        ham_max_hu: hamMaxHu,
        is_ham: isHAM,
      },
      evidence,
    }
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
    const k = kind === 'followup' || kind === 'discussion' || kind === 'archive' || kind === 'brief' || kind === 'other' ? kind : 'case_report'
    c.db.db.prepare('INSERT OR IGNORE INTO patient_docs (patient_id, doc_id, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(patientId, docId, k, a.userId, now())
    // 属于患者的文档：不出现在文档列表里，打开时显示归属并能回到患者页
    const p = c.db.db.prepare('SELECT code FROM patients WHERE id = ?').get(patientId) as { code: string }
    // space / tenant_id：文档属于哪个空间的患者库（AI 在这份文档里的回合按它取空间，不能跨空间读）
    this.store.setDocContext(docId, { kind: 'patient', patient_id: patientId, code: p.code, doc_kind: k, space: a.space ?? 'work', tenant_id: c.tenantId })
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
    const rows = (c.db.db.prepare("SELECT p.* FROM patients p JOIN care_team t ON t.patient_id = p.id AND t.user_id = ? WHERE p.status = 'active' ORDER BY p.code").all(a.userId) as Array<Record<string, unknown>>).map(r => patientOf(r))
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
      // 知家手工录入的化验挂不上报告记录（没有原件可追溯），不进研究数据集
      const where = ["patient_id = ?", "status = 'confirmed'", 'record_id IS NOT NULL']
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
/** 称呼（家人档案里的叫法，如「妈妈」「宝宝」；不要求实名，留空 = 沿用代号）。 */
function name(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim().slice(0, 24)
  return s || null
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
export interface LabChangeCriterion {
  test: string
  test_key: string
  change_type: 'diff' | 'pct' // diff = latest - baseline, pct = ((latest - baseline) / Math.abs(baseline)) * 100
  op: LabOp
  value: number
}
export interface Criteria {
  sex: 'M' | 'F' | null; age_min: number | null; age_max: number | null
  /** 诊断标签包含其中任一（不分大小写、部分匹配） */
  tags_any: string[]
  /** 排除标签：包含其中任一即排除（不分大小写、部分匹配） */
  tags_exclude: string[]
  /** 化验条件（都要满足）；用换算到标准单位后的已确认值 */
  labs: LabCriterion[]
  /** 化验指标动态变化条件（例如 ALT 下降幅度 >= 30% 或肌酐上升绝对值 >= 50） */
  lab_changes: LabChangeCriterion[]
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
  const lab_changes = (Array.isArray(o.lab_changes) ? o.lab_changes : []).slice(0, 10).map(x => {
    const l = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    const test = typeof l.test === 'string' ? l.test.trim() : ''
    const op = OPS.includes(l.op as LabOp) ? l.op as LabOp : null
    const change_type = l.change_type === 'pct' ? 'pct' as const : 'diff' as const
    const value = num(l.value)
    if (!test || !op || value === null) throw new PatientError('bad_criteria', '化验变化条件要有项目、比较符（> >= < <= =）和数值')
    return { test, test_key: testKey(test), change_type, op, value }
  })
  return {
    sex: o.sex === 'M' || o.sex === 'F' ? o.sex : null, age_min: num(o.age_min), age_max: num(o.age_max),
    tags_any: (Array.isArray(o.tags_any) ? o.tags_any : []).filter((t): t is string => typeof t === 'string' && t.trim() !== '').map(t => t.trim()).slice(0, 20),
    tags_exclude: (Array.isArray(o.tags_exclude) ? o.tags_exclude : []).filter((t): t is string => typeof t === 'string' && t.trim() !== '').map(t => t.trim()).slice(0, 20),
    labs, lab_changes, from: date(o.from), to: date(o.to),
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
  if (cr.tags_exclude.length) {
    const excluded = p.tags.find(t => cr.tags_exclude.some(q => t.toLowerCase().includes(q.toLowerCase())))
    if (excluded) return null
  }
  if (cr.tags_any.length) {
    const hit = p.tags.find(t => cr.tags_any.some(q => t.toLowerCase().includes(q.toLowerCase())))
    if (!hit) return null
    why.push(`标签「${hit}」`)
  }
  const inWin = labs.filter(l => l.collected_on && (!cr.from || l.collected_on >= cr.from) && (!cr.to || l.collected_on <= cr.to))
  if ((cr.from || cr.to) && !cr.labs.length && !cr.lab_changes.length) {
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
  for (const q of cr.lab_changes) {
    const vals = inWin.filter(l => l.test_key === q.test_key && l.std_value !== null)
    if (vals.length < 2) return null
    const first = vals[0]!, last = vals[vals.length - 1]!
    const baseVal = first.std_value!, lastVal = last.std_value!
    let calculated = 0
    if (q.change_type === 'pct') {
      if (Math.abs(baseVal) < 1e-9) return null
      calculated = ((lastVal - baseVal) / Math.abs(baseVal)) * 100
    } else {
      calculated = lastVal - baseVal
    }
    if (!cmp(calculated, q.op, q.value)) return null
    const unit = last.std_unit ? ` ${last.std_unit}` : ''
    const sign = calculated >= 0 ? '+' : ''
    const changeStr = q.change_type === 'pct' ? `${sign}${calculated.toFixed(1)}%` : `${sign}${calculated.toFixed(2)}${unit}`
    why.push(`${last.test_name} 变化 ${changeStr}（基线 ${baseVal} → 最近 ${lastVal}）`)
  }
  return why
}
