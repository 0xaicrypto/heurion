/**
 * #446 — persistent job store for the execution plane.
 *
 * JOBS was an in-memory Map: restarts lost every job and multi-instance
 * polling returned 404. This store persists job records + the fileId index
 * to JSONL under the worker data dir, reloads on boot and survives restarts.
 * (Single-writer append-only; enough for one worker instance. Horizontal
 * scaling would move this to Redis Streams.)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

export interface JobRecord {
  id: string
  type: string
  status: 'pending' | 'running' | 'completed' | 'failed'
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

const dataDir = process.env.WORKER_DATA_DIR || join(process.cwd(), '.worker-data')
const jobsPath = join(dataDir, 'jobs.jsonl')
const filesPath = join(dataDir, 'files.jsonl')

function ensureDir(): void {
  mkdirSync(dataDir, { recursive: true })
}

function loadJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  const out: T[] = []
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as T)
      } catch { /* skip corrupted line */ }
    }
  } catch { /* unreadable — start fresh */ }
  return out
}

function appendJsonl<T>(path: string, record: T): void {
  ensureDir()
  writeFileSync(path, JSON.stringify(record) + '\n', { flag: 'a' })
}

export class PersistentJobStore {
  private jobs = new Map<string, JobRecord>()
  private files = new Map<string, FileIndexEntry>()

  constructor() {
    for (const job of loadJsonl<JobRecord>(jobsPath)) {
      this.jobs.set(job.id, job)
    }
    for (const entry of loadJsonl<FileIndexEntry>(filesPath)) {
      this.files.set(entry.fileId, entry)
    }
  }

  create(id: string, type: string): JobRecord {
    const job: JobRecord = { id, type, status: 'pending', created_at: Date.now() / 1000 }
    this.jobs.set(id, job)
    appendJsonl(jobsPath, job)
    return job
  }

  update(id: string, patch: Partial<JobRecord>): JobRecord | null {
    const job = this.jobs.get(id)
    if (!job) return null
    Object.assign(job, patch)
    appendJsonl(jobsPath, job)
    return job
  }

  get(id: string): JobRecord | null {
    return this.jobs.get(id) ?? null
  }

  findJobByFileId(fileId: string): JobRecord | null {
    const entry = this.files.get(fileId)
    if (entry) return this.jobs.get(entry.jobId) ?? null
    for (const job of this.jobs.values()) {
      if (job.result?.fileId === fileId) return job
    }
    return null
  }

  /** O(1) file lookup independent of the job map (#446). */
  getFileEntry(fileId: string): FileIndexEntry | null {
    return this.files.get(fileId) ?? null
  }

  indexFile(entry: FileIndexEntry): void {
    this.files.set(entry.fileId, entry)
    appendJsonl(filesPath, entry)
  }
}
