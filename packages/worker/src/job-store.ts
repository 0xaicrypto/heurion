/**
 * #446 — persistent job store for the execution plane.
 *
 * JOBS was an in-memory Map: restarts lost every job and multi-instance
 * polling returned 404. This store persists job records + the fileId index
 * to JSONL under the worker data dir, reloads on boot and survives restarts.
 * (Single-writer append-only; enough for one worker instance. Horizontal
 * scaling would move this to Redis Streams.)
 *
 * #656: the append-only log is periodically compacted (latest record per
 * job id) so long-running workers do not grow jobs.jsonl unboundedly.
 *
 * #915: compaction now covers the file manifests too (files.jsonl here,
 * local-files.jsonl in storage.ts — same fileId keeps its latest record),
 * the { __recovered } marker line is filtered on load instead of being
 * replayed as an id-less JobRecord, and crash-interrupted `pending` jobs
 * are recovered alongside `running` ones.
 */
import { mkdirSync } from 'fs'
import { join } from 'path'
import type { JobStatus } from '@heurion/contracts'
// #795: path + JSONL helpers moved to the shared data-dir module so the
// storage manifest and the job log share one location and one loader.
import { workerDataDir, loadJsonl, appendJsonl, atomicWriteFileSync } from './data-dir.js'

export interface JobRecord {
  id: string
  type: string
  status: JobStatus
  created_at: number
  completed_at?: number
  result?: Record<string, unknown>
  error?: string
}

interface FileIndexEntry {
  fileId: string
  jobId: string
  fileName: string
  mimeType: string
}

const jobsPath = join(workerDataDir(), 'jobs.jsonl')
const filesPath = join(workerDataDir(), 'files.jsonl')
/** #656: rewrite the append-only log every N updates, keeping only the
 *  latest record per key — the map is authoritative, the file is a replay
 *  log, so dropping superseded lines loses nothing. */
const COMPACTION_EVERY = 200

/**
 * #1148: 终态作业 TTL — jobs.jsonl 只压缩不淘汰,长跑 worker/重启循环下
 * 记录(含 result 里的 download_url 等)无限增长。默认 7 天;显式 0/负 → 关闭
 * (保留全量,兼容排障场景)。
 */
const DEFAULT_JOB_TTL_DAYS = 7

export function resolveJobTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WORKER_JOB_TTL_DAYS
  if (raw === undefined || raw.trim() === '') return DEFAULT_JOB_TTL_DAYS * 86_400
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n * 86_400
}

function ensureDir(): void {
  mkdirSync(workerDataDir(), { recursive: true })
}

export class PersistentJobStore {
  private jobs = new Map<string, JobRecord>()
  private files = new Map<string, FileIndexEntry>()
  // #915: jobs 与 files 各自计数 — 此前共享一个计数器,indexFile 与
  // job 写入互相消耗阈值,两份日志的压缩节奏不可控。
  private jobWritesSinceCompact = 0
  private fileWritesSinceCompact = 0

  constructor() {
    // #915: recoverInterrupted 追加的 { __recovered, at } marker 行没有
    // id — 过滤掉,不能 set(undefined) 污染作业表(压缩只从 map 重写,
    // 无效行自然不会写回)。
    for (const job of loadJsonl<JobRecord>(jobsPath)) {
      if (!job.id) continue
      this.jobs.set(job.id, job)
    }
    for (const entry of loadJsonl<FileIndexEntry>(filesPath)) {
      if (!entry.fileId) continue
      this.files.set(entry.fileId, entry)
    }
    // #1148: 启动即淘汰过期终态记录（含无主 files 索引条目）。
    this.pruneExpired()
  }

  /**
   * #1148: 淘汰 TTL 之外的终态作业（running/pending 永不淘汰 — 它们是
   * 活跃/待恢复状态）及其 files 索引条目。返回淘汰数；有淘汰时重写两份
   * jsonl（内存 map 即权威态）。
   */
  pruneExpired(nowSec: number = Date.now() / 1000, ttlSeconds: number = resolveJobTtlSeconds()): number {
    if (ttlSeconds <= 0) return 0
    const cutoff = nowSec - ttlSeconds
    let removed = 0
    for (const [id, job] of this.jobs) {
      if (job.status === 'running' || job.status === 'pending') continue
      if ((job.completed_at ?? job.created_at) >= cutoff) continue
      this.jobs.delete(id)
      removed++
    }
    if (removed === 0) return 0
    ensureDir()
    this.writeJobsFile()
    // #1150-followup: 文件索引不随 job TTL 级联删除 — 产物文件保留 30 天
    // (artifact cleanup 管),job 记录只活 7 天;此前级联把 files 条目一起删,
    // 第 7~30 天的下载(fileId 查索引)全部 404。索引生命周期跟随产物清理
    // (local-files.jsonl 由 cleanup 剪枝),与 job 记录解耦。
    return removed
  }

  /** #656: startup recovery — jobs left `running` by a crashed process can
   *  never finish; mark them failed so polling gets a definitive answer.
   *  #915: 崩溃时仍为 pending 的作业同理,否则重启后永远 pending。 */
  recoverInterrupted(): number {
    let recovered = 0
    for (const job of this.jobs.values()) {
      if (job.status === 'running' || job.status === 'pending') {
        job.status = 'failed'
        job.error = job.error || 'Interrupted by worker restart'
        job.completed_at = Date.now() / 1000
        recovered++
      }
    }
    if (recovered > 0) appendJsonl(jobsPath, { __recovered: recovered, at: Date.now() / 1000 })
    return recovered
  }

  create(id: string, type: string): JobRecord {
    const job: JobRecord = { id, type, status: 'pending', created_at: Date.now() / 1000 }
    this.jobs.set(id, job)
    appendJsonl(jobsPath, job)
    this.maybeCompactJobs()
    return job
  }

  update(id: string, patch: Partial<JobRecord>): JobRecord | null {
    const job = this.jobs.get(id)
    if (!job) return null
    Object.assign(job, patch)
    appendJsonl(jobsPath, job)
    this.maybeCompactJobs()
    return job
  }

  get(id: string): JobRecord | null {
    return this.jobs.get(id) ?? null
  }
  /** O(1) file lookup independent of the job map (#446). */
  getFileEntry(fileId: string): FileIndexEntry | null {
    return this.files.get(fileId) ?? null
  }

  indexFile(entry: FileIndexEntry): void {
    this.files.set(entry.fileId, entry)
    appendJsonl(filesPath, entry)
    this.maybeCompactFiles()
  }

  /** #656: rewrite jobs.jsonl with only the latest record per job id. */
  private maybeCompactJobs(): void {
    this.jobWritesSinceCompact++
    if (this.jobWritesSinceCompact < COMPACTION_EVERY) return
    this.jobWritesSinceCompact = 0
    this.writeJobsFile()
  }

  private writeJobsFile(): void {
    ensureDir()
    const lines = [...this.jobs.values()].map((j) => JSON.stringify(j)).join('\n')
    atomicWriteFileSync(jobsPath, lines ? lines + '\n' : '')
  }

  /** #915: files.jsonl same treatment — latest record per fileId; the map
   *  is authoritative, so id-less marker lines are never written back. */
  private maybeCompactFiles(): void {
    this.fileWritesSinceCompact++
    if (this.fileWritesSinceCompact < COMPACTION_EVERY) return
    this.fileWritesSinceCompact = 0
    this.writeFilesFile()
  }

  private writeFilesFile(): void {
    ensureDir()
    const lines = [...this.files.values()].map((e) => JSON.stringify(e)).join('\n')
    atomicWriteFileSync(filesPath, lines ? lines + '\n' : '')
  }
}
