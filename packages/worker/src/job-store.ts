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
 */
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { JobStatus } from '@heurion/contracts'
// #795: path + JSONL helpers moved to the shared data-dir module so the
// storage manifest and the job log share one location and one loader.
import { workerDataDir, loadJsonl, appendJsonl } from './data-dir.js'

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

function ensureDir(): void {
  mkdirSync(workerDataDir(), { recursive: true })
}

export class PersistentJobStore {
  private jobs = new Map<string, JobRecord>()
  private files = new Map<string, FileIndexEntry>()
  private writesSinceCompact = 0

  constructor() {
    for (const job of loadJsonl<JobRecord>(jobsPath)) {
      this.jobs.set(job.id, job)
    }
    for (const entry of loadJsonl<FileIndexEntry>(filesPath)) {
      this.files.set(entry.fileId, entry)
    }
  }

  /** #656: startup recovery — jobs left `running` by a crashed process can
   *  never finish; mark them failed so polling gets a definitive answer. */
  recoverInterrupted(): number {
    let recovered = 0
    for (const job of this.jobs.values()) {
      if (job.status === 'running') {
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
    this.maybeCompact()
    return job
  }

  update(id: string, patch: Partial<JobRecord>): JobRecord | null {
    const job = this.jobs.get(id)
    if (!job) return null
    Object.assign(job, patch)
    appendJsonl(jobsPath, job)
    this.maybeCompact()
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
    this.maybeCompact()
  }

  /** #656: rewrite jobs.jsonl with only the latest record per job id. */
  private maybeCompact(): void {
    this.writesSinceCompact++
    if (this.writesSinceCompact < COMPACTION_EVERY) return
    this.writesSinceCompact = 0
    ensureDir()
    const lines = [...this.jobs.values()].map((j) => JSON.stringify(j)).join('\n')
    writeFileSync(jobsPath, lines ? lines + '\n' : '', 'utf-8')
  }
}
