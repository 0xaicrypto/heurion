/**
 * Execution Plane client — submits async Sidecar / plugin jobs to the
 * sandbox worker and polls for their status.
 */

export interface ExecutionJob {
  type: string
  payload: Record<string, unknown>
  tenant?: { userId?: string; workspaceId?: string }
  callbackUrl?: string
}

export interface ExecutionJobStatus {
  job_id: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'unknown'
  created_at: number
  result?: Record<string, unknown>
}

export interface FileDownloadUrl {
  file_id: string
  file_name: string
  mime_type: string
  download_url: string
  expires_in: number
}

export interface ExecutionPlaneService {
  enqueue(job: ExecutionJob): Promise<ExecutionJobStatus>
  getStatus(jobId: string): Promise<ExecutionJobStatus | null>
  getDownloadUrl(fileId: string): Promise<FileDownloadUrl | null>
}

const WORKER_URL = process.env.EXECUTION_PLANE_URL?.replace(/\/$/, '')
const WORKER_TOKEN = process.env.WORKER_API_TOKEN

class HttpExecutionPlaneService implements ExecutionPlaneService {
  async enqueue(job: ExecutionJob): Promise<ExecutionJobStatus> {
    const res = await fetch(`${WORKER_URL}/api/v1/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-worker-token': WORKER_TOKEN!,
      },
      body: JSON.stringify({
        type: job.type,
        payload: job.payload,
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
    const res = await fetch(`${WORKER_URL}/api/v1/jobs/${jobId}`, {
      headers: { 'x-worker-token': WORKER_TOKEN! },
    })
    if (res.status === 404) return null
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Execution Plane status failed: ${res.status} ${text}`)
    }
    return res.json() as Promise<ExecutionJobStatus>
  }

  async getDownloadUrl(fileId: string): Promise<FileDownloadUrl | null> {
    const res = await fetch(`${WORKER_URL}/api/v1/files/${fileId}/download`, {
      headers: { 'x-worker-token': WORKER_TOKEN! },
    })
    if (res.status === 404) return null
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Execution Plane download failed: ${res.status} ${text}`)
    }
    return res.json() as Promise<FileDownloadUrl>
  }
}

class StubExecutionPlaneService implements ExecutionPlaneService {
  private jobs: Map<string, ExecutionJobStatus> = new Map()

  async enqueue(job: ExecutionJob): Promise<ExecutionJobStatus> {
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
}

export function createExecutionPlaneService(): ExecutionPlaneService {
  if (WORKER_URL && WORKER_TOKEN) {
    return new HttpExecutionPlaneService()
  }
  return new StubExecutionPlaneService()
}
