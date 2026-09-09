/**
 * Execution Plane client — submits async Sidecar / plugin jobs to the
 * sandbox worker and polls for their status.
 *
 * #448: no silent stub in production. The stub is a dev/test affordance;
 * in production a missing worker configuration fails loudly on enqueue.
 */
import type { JobStatusResponse, SidecarFileInfo } from '@heurion/contracts'
import { makeLogger } from '../../common/logger.js'

const log = makeLogger('execution-plane')

/** Enqueue payload — `callbackUrl` (camelCase, client-side) maps to the
 * wire field `callback_url` at send time. */
export interface ExecutionJob {
  type: string
  payload: Record<string, unknown>
  tenant?: { userId?: string; workspaceId?: string }
  callbackUrl?: string
}

export type ExecutionJobStatus = JobStatusResponse

export type FileDownloadUrl = SidecarFileInfo

export interface ExecutionPlaneService {
  enqueue(job: ExecutionJob): Promise<ExecutionJobStatus>
  getStatus(jobId: string): Promise<ExecutionJobStatus | null>
  getDownloadUrl(fileId: string): Promise<FileDownloadUrl | null>
  /**
   * #766: raw file bytes — server-side 落盘 for draft embedding (chart-token
   * URLs need a stable local file; the worker download URL itself is
   * token-gated and expiring, unusable inside a document).
   */
  fetchFile(fileId: string): Promise<Buffer | null>
}

function isDev(): boolean {
  const env = process.env.NODE_ENV || 'development'
  return env === 'development' || env === 'test'
}

// #448/#441: env read lazily per call (no import-time snapshot).
function workerUrl(): string | undefined {
  return process.env.EXECUTION_PLANE_URL?.replace(/\/$/, '')
}

function workerToken(): string | undefined {
  return process.env.WORKER_API_TOKEN
}

class HttpExecutionPlaneService implements ExecutionPlaneService {
  async enqueue(job: ExecutionJob): Promise<ExecutionJobStatus> {
    const url = workerUrl()
    const token = workerToken()
    if (!url || !token) {
      throw new Error('Execution Plane is not configured (EXECUTION_PLANE_URL / WORKER_API_TOKEN missing)')
    }
    const res = await fetch(`${url}/api/v1/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-worker-token': token,
      },
      body: JSON.stringify({
        type: job.type,
        // #928 备注:tenant 字段当前仅透传记录——worker 侧(storage.ts
        // saveFile)并不读 payload.tenant,S3 key 只由 prefix/fileId/fileName
        // 构成,S3 路径未按 tenant 隔离(实现属 feature,见 #928)。
        payload: { ...job.payload, tenant: job.tenant ?? {} },
        tenant: job.tenant ?? {},
        callback_url: job.callbackUrl,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Execution Plane enqueue failed: ${res.status} ${text}`)
    }
    return res.json() as Promise<ExecutionJobStatus>
  }

  async getStatus(jobId: string): Promise<ExecutionJobStatus | null> {
    const url = workerUrl()
    const token = workerToken()
    if (!url || !token) {
      throw new Error('Execution Plane is not configured (EXECUTION_PLANE_URL / WORKER_API_TOKEN missing)')
    }
    const res = await fetch(`${url}/api/v1/jobs/${jobId}`, {
      headers: { 'x-worker-token': token },
    })
    if (res.status === 404) return null
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Execution Plane status failed: ${res.status} ${text}`)
    }
    return res.json() as Promise<ExecutionJobStatus>
  }

  async getDownloadUrl(fileId: string): Promise<FileDownloadUrl | null> {
    const url = workerUrl()
    const token = workerToken()
    if (!url || !token) {
      throw new Error('Execution Plane is not configured (EXECUTION_PLANE_URL / WORKER_API_TOKEN missing)')
    }
    const res = await fetch(`${url}/api/v1/files/${fileId}/download`, {
      headers: { 'x-worker-token': token },
    })
    if (res.status === 404) return null
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Execution Plane download failed: ${res.status} ${text}`)
    }
    return res.json() as Promise<FileDownloadUrl>
  }

  async fetchFile(fileId: string): Promise<Buffer | null> {
    const download = await this.getDownloadUrl(fileId)
    if (!download?.download_url) return null
    // #785: local-mode workers return a RELATIVE proxy path
    // (/api/v1/files/:id/content) — undici's fetch cannot parse relative
    // URLs, so anchor it on the configured worker base URL.
    const target = /^https?:\/\//i.test(download.download_url)
      ? download.download_url
      : `${workerUrl() ?? ''}${download.download_url}`
    const token = workerToken()
    const res = await fetch(target, {
      headers: token ? { 'x-worker-token': token } : {},
    })
    if (res.status === 404) return null
    if (!res.ok) {
      throw new Error(`Execution Plane file fetch failed: ${res.status}`)
    }
    return Buffer.from(await res.arrayBuffer())
  }
}

class StubExecutionPlaneService implements ExecutionPlaneService {
  private jobs: Map<string, ExecutionJobStatus> = new Map()

  async enqueue(job: ExecutionJob): Promise<ExecutionJobStatus> {
    // #448: explicit warning — a stub completion is NOT a real render.
    log.warn(`[execution-plane] STUB enqueue (${job.type}) — worker not configured; this is NOT a real render.`)
    const id = `job_stub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const status: ExecutionJobStatus = {
      job_id: id,
      status: 'completed',
      created_at: Date.now() / 1000,
      result: { acknowledged: true, type: job.type, mode: 'stub' },
    }
    this.jobs.set(id, status)
    return status
  }

  async getStatus(jobId: string): Promise<ExecutionJobStatus | null> {
    return this.jobs.get(jobId) ?? null
  }

  async getDownloadUrl(_fileId: string): Promise<FileDownloadUrl | null> {
    return null
  }

  async fetchFile(_fileId: string): Promise<Buffer | null> {
    return null
  }
}

export function createExecutionPlaneService(): ExecutionPlaneService {
  // #448: the stub is dev/test ONLY — production without a worker must fail
  // loudly at the first enqueue (HTTP service throws), never fake success.
  if (!isDev() && !(workerUrl() && workerToken())) {
    log.warn('[execution-plane] PRODUCTION without EXECUTION_PLANE_URL/WORKER_API_TOKEN — plugin renders will fail loudly.')
  }
  if (workerUrl() && workerToken()) {
    return new HttpExecutionPlaneService()
  }
  return new StubExecutionPlaneService()
}
