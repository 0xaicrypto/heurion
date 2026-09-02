/**
 * Job runner (#686) — bounded-concurrency execution state machine extracted
 * from server.ts: slot accounting (whenSlotFree/releaseSlot) + the
 * running→completed/failed transitions + #446 file indexing + #449
 * fire-and-forget callback. Routes only declare the handler table.
 */
import type { PersistentJobStore } from './job-store.js'
import type { RenderJobType } from '@heurion/contracts'

const MAX_CONCURRENT_JOBS = parseInt(process.env.WORKER_MAX_CONCURRENT || '4', 10)
let activeJobs = 0
const jobQueue: Array<() => void> = []

function whenSlotFree(): Promise<void> {
  if (activeJobs < MAX_CONCURRENT_JOBS) {
    activeJobs++
    return Promise.resolve()
  }
  return new Promise((resolve) => jobQueue.push(() => {
    activeJobs++
    resolve()
  }))
}

function releaseSlot(): void {
  activeJobs--
  const next = jobQueue.shift()
  if (next) next()
}

export type JobHandler = (payload: unknown) => Promise<unknown>

function notify(url: string | undefined, body: Record<string, unknown>): void {
  if (!url) return
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {})
}

/** Execute one job under the concurrency cap; never throws (state machine owns failures). */
export async function runJob(input: {
  jobStore: PersistentJobStore
  id: string
  type: RenderJobType
  payload: unknown
  handler: JobHandler
  callbackUrl?: string
}): Promise<void> {
  const { jobStore, id, payload, handler, callbackUrl } = input
  await whenSlotFree()
  try {
    jobStore.update(id, { status: 'running' })
    const result = await handler(payload)
    jobStore.update(id, { status: 'completed', result: result as Record<string, unknown>, completed_at: Date.now() / 1000 })
    // #446: index the produced file for O(1) download lookups.
    if (result && typeof result === 'object' && 'file_id' in (result as Record<string, unknown>)) {
      const r = result as Record<string, unknown>
      jobStore.indexFile({
        fileId: String(r.file_id),
        jobId: id,
        fileName: String(r.file_name || 'output'),
        mimeType: String(r.mime_type || 'application/octet-stream'),
      } as never)
    }
    // #449: fire-and-forget completion callback.
    notify(callbackUrl, { job_id: id, status: 'completed', result, error: undefined })
  } catch (err) {
    const message = (err as Error).message || 'Handler failed'
    jobStore.update(id, { status: 'failed', error: message, completed_at: Date.now() / 1000 })
    notify(callbackUrl, { job_id: id, status: 'failed', error: message })
  } finally {
    releaseSlot()
  }
}
