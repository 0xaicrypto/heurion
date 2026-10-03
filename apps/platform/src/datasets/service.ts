import { createHash } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { DatasetRow, Store } from '../store/db.ts'
import type { ColumnProfile, Ingest, Profile } from './ingest.ts'

/**
 * 数据集（实验室数据分析 · 第一期）：医生上传大样本表格，AI 在隔离环境里用 Python 分析，结果（Table 1、图、方法与结果段落）写进文稿。
 * - 上传 → 在用户的隔离环境里解析（ingest.ts）→ 概况（列类型、缺失、摘要）。
 * - 疑似身份信息的列（姓名、证件号、电话、病历号、地址、出生日期、邮箱）必须由用户逐列处理：删掉，或明确确认「不是身份信息」，
 *   之后才能被 AI 使用（status=review → ready）。
 * - AI 经 MCP 的 dataset_list / dataset_describe / dataset_open 使用；只读，不能绕过确认。
 * 归属：按用户（owner）。以后加租户时数据集归租户，查询改按 tenant_id。
 */

export const DATASET_FORMATS: Record<string, string> = {
  '.csv': 'CSV', '.tsv': 'TSV', '.txt': 'CSV', '.xlsx': 'Excel', '.xlsm': 'Excel', '.xls': 'Excel',
  '.xpt': 'SAS', '.sas7bdat': 'SAS', '.sav': 'SPSS', '.zsav': 'SPSS', '.dta': 'Stata',
}
export const DATASET_MAX_BYTES = 100 * 1024 * 1024

export class DatasetError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export interface DatasetView extends Omit<DatasetRow, 'profile' | 'labels'> {
  columns: ColumnProfile[]
  labels: Record<string, string>
  /** 待用户处理的疑似身份信息列 */
  phi: Array<{ name: string; reason: string }>
  truncated: boolean
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')

export class DatasetService {
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly store: Store, private readonly dir: string, private readonly ingest: Ingest) {
    // 服务重启时没处理完的重新处理
    for (const d of store.processingDatasets()) this.schedule(d.id)
  }

  private folder(d: Pick<DatasetRow, 'owner' | 'id'>): string { return join(this.dir, safe(d.owner), d.id) }
  private original(d: DatasetRow): string { return join(this.folder(d), 'original' + extname(d.filename).toLowerCase()) }
  csvPath(d: DatasetRow): string { return join(this.folder(d), 'data.csv') }

  /** 上传：同一用户重复上传同一文件返回已有的。处理在后台排队进行。 */
  upload(owner: string, filename: string, bytes: Uint8Array): { dataset: DatasetView; duplicate: boolean } {
    const ext = extname(filename).toLowerCase()
    const format = DATASET_FORMATS[ext]
    if (!format) throw new DatasetError('bad_format', `不支持的格式：${ext || '无扩展名'}（支持 CSV、Excel、SAS、SPSS、Stata）`)
    if (bytes.byteLength === 0) throw new DatasetError('empty', '文件是空的')
    if (bytes.byteLength > DATASET_MAX_BYTES) throw new DatasetError('too_large', '文件超过 100 MB')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const same = this.store.findDatasetBySha(owner, sha256)
    if (same) return { dataset: this.view(same), duplicate: true }
    const name = filename.replace(/\.[^.]+$/, '').slice(0, 120) || '数据集'
    const row = this.store.addDataset({ owner, name, filename: filename.slice(0, 200), format, size: bytes.byteLength, sha256 })
    mkdirSync(this.folder(row), { recursive: true })
    writeFileSync(this.original(row), bytes)
    this.schedule(row.id)
    return { dataset: this.view(row), duplicate: false }
  }

  /** 逐个处理（解析很快，但大文件占内存，不并发）。 */
  private schedule(id: string, drop: string[] = []): Promise<void> {
    this.queue = this.queue.then(() => this.process(id, drop)).catch(err => console.error('[datasets]', id, err))
    return this.queue
  }

  /** 等后台处理完（测试用）。 */
  idle(): Promise<void> { return this.queue }

  private async process(id: string, drop: string[]): Promise<void> {
    const d = this.store.getDataset(id)
    if (!d) return
    let r
    try {
      r = await this.ingest(d.owner, this.original(d), drop)
    } catch (err) {
      this.store.updateDataset(id, { status: 'failed', error: (err as Error).message.slice(0, 300) })
      return
    }
    try {
      if (!this.store.getDataset(id)) return // 处理期间被删了
      if (!r.profile.ok || !r.csv) {
        this.store.updateDataset(id, { status: 'failed', error: r.profile.ok ? '没有生成数据' : r.profile.error })
        return
      }
      const tmp = this.csvPath(d) + '.tmp'
      copyFileSync(r.csv, tmp)
      renameSync(tmp, this.csvPath(d))
      chmodSync(this.csvPath(d), 0o640)
      const phi = r.profile.columns.filter(c => c.phi)
      this.store.updateDataset(id, { status: phi.length ? 'review' : 'ready', rows: r.profile.rows, cols: r.profile.columns.length, profile: JSON.stringify(r.profile), error: null })
    } finally {
      r.cleanup()
    }
  }

  /**
   * 处理疑似身份信息的列：drop 里的删掉，keep 里的是用户确认「不是身份信息」的。每个被标出的列都必须二选一。
   * 有要删的列时重新解析（从原文件），删完再检查一遍。
   */
  async resolvePhi(owner: string, id: string, drop: string[], keep: string[]): Promise<DatasetView> {
    const d = this.own(owner, id)
    if (d.status !== 'review') throw new DatasetError('not_in_review', '这个数据集不需要处理身份信息')
    const flagged = this.phiOf(d).map(c => c.name)
    const missing = flagged.filter(n => !drop.includes(n) && !keep.includes(n))
    if (missing.length) throw new DatasetError('unresolved', `还有列没处理：${missing.join('、')}（删掉，或确认不是身份信息）`)
    const prev = JSON.parse(d.profile!) as Extract<Profile, { ok: true }>
    if (drop.length) {
      this.store.updateDataset(id, { status: 'processing' })
      await this.schedule(id, drop.filter(n => flagged.includes(n) || prev.columns.some(c => c.name === n)))
    }
    // 用户确认保留的列：去掉标记，记下确认（审计里也有记录）
    const cur = this.store.getDataset(id)!
    if (cur.status === 'failed') return this.view(cur)
    const profile = JSON.parse(cur.profile!) as Extract<Profile, { ok: true }>
    for (const c of profile.columns) if (c.phi && keep.includes(c.name)) delete c.phi
    const still = profile.columns.filter(c => c.phi)
    this.store.updateDataset(id, { profile: JSON.stringify({ ...profile, phi_resolved: { dropped: drop, kept: keep, at: new Date().toISOString() } }), status: still.length ? 'review' : 'ready' })
    return this.view(this.store.getDataset(id)!)
  }

  list(owner: string): DatasetView[] { return this.store.listDatasets(owner).map(d => this.view(d)) }

  get(owner: string, id: string): DatasetView { return this.view(this.own(owner, id)) }

  update(owner: string, id: string, patch: { name?: string; labels?: Record<string, string> }): DatasetView {
    const d = this.own(owner, id)
    const next: Parameters<Store['updateDataset']>[1] = {}
    if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim().slice(0, 120)
    if (patch.labels && typeof patch.labels === 'object') {
      const cols = new Set(this.view(d).columns.map(c => c.name))
      const labels: Record<string, string> = { ...this.view(d).labels }
      for (const [k, v] of Object.entries(patch.labels)) {
        if (!cols.has(k)) continue
        if (typeof v === 'string' && v.trim()) labels[k] = v.trim().slice(0, 80)
        else delete labels[k]
      }
      next.labels = JSON.stringify(labels)
    }
    this.store.updateDataset(id, next)
    return this.view(this.store.getDataset(id)!)
  }

  remove(owner: string, id: string): void {
    const d = this.own(owner, id)
    this.store.deleteDataset(id)
    rmSync(this.folder(d), { recursive: true, force: true })
  }

  /** 前 limit 行（预览）。 */
  preview(owner: string, id: string, limit = 50): { header: string[]; rows: string[][] } {
    const d = this.own(owner, id)
    if (!existsSync(this.csvPath(d))) return { header: [], rows: [] }
    const records = parseCsv(readHead(this.csvPath(d), limit + 1))
    return { header: records[0] ?? [], rows: records.slice(1, limit + 1) }
  }

  /** AI 打开数据：只有可用（ready）的。返回规范化 CSV 的路径。 */
  readyCsv(owner: string, id: string): { dataset: DatasetView; path: string } {
    const d = this.own(owner, id)
    if (d.status === 'review') throw new DatasetError('needs_review', '这个数据集有疑似身份信息的列，用户还没处理，暂不能使用')
    if (d.status !== 'ready') throw new DatasetError('not_ready', d.status === 'failed' ? `数据集导入失败：${d.error ?? ''}` : '数据集还在处理')
    return { dataset: this.view(d), path: this.csvPath(d) }
  }

  private own(owner: string, id: string): DatasetRow {
    const d = this.store.getDataset(id)
    if (!d || d.owner !== owner) throw new DatasetError('not_found', '数据集不存在')
    return d
  }

  private phiOf(d: DatasetRow): ColumnProfile[] {
    if (!d.profile) return []
    const p = JSON.parse(d.profile) as Profile
    return p.ok ? p.columns.filter(c => c.phi) : []
  }

  private view(d: DatasetRow): DatasetView {
    const p = d.profile ? JSON.parse(d.profile) as Profile : null
    const columns = p && p.ok ? p.columns : []
    const { profile: _p, labels, ...rest } = d
    return { ...rest, columns, labels: JSON.parse(labels || '{}') as Record<string, string>, phi: columns.filter(c => c.phi).map(c => ({ name: c.name, reason: c.phi!.reason })), truncated: Boolean(p && p.ok && p.truncated) }
  }
}

/** 读文件开头够 n 条记录的部分（预览不读整个大文件）。 */
function readHead(path: string, n: number): string {
  const fd = openSync(path, 'r')
  const buf = Buffer.alloc(4 * 1024 * 1024)
  const len = readSync(fd, buf, 0, buf.length, 0)
  closeSync(fd)
  return headOf(buf.subarray(0, len), n)
}

function headOf(buf: Buffer, n: number): string {
  let lines = 0
  let quoted = false
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i]
    if (ch === 0x22) quoted = !quoted
    else if (ch === 0x0a && !quoted && ++lines >= n) return buf.subarray(0, i).toString('utf8')
  }
  return buf.toString('utf8')
}

/** RFC 4180 CSV（引号、转义引号、引号内换行）。 */
export function parseCsv(text: string): string[][] {
  const out: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); out.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row) }
  return out
}
