/**
 * Job runner (#686) — bounded-concurrency execution state machine extracted
 * from server.ts: slot accounting (whenSlotFree/releaseSlot) + the
 * running→completed/failed transitions + #446 file indexing + #449
 * fire-and-forget callback. Routes only declare the handler table.
 */
import type { PersistentJobStore } from './job-store.js'
import type { RenderJobType } from '@heurion/contracts'

const DEFAULT_MAX_CONCURRENT_JOBS = 4

/**
 * #928: WORKER_MAX_CONCURRENT 解析 clamp — 0/NaN/负数此前静默生效:
 * whenSlotFree 的 `activeJobs < MAX` 对 0 恒假、对 NaN 恒假(比较恒 false),
 * 作业全部进 jobQueue 永久排队且无任何日志。非法值 → warn + 回退默认 4。
 */
export function parseMaxConcurrentJobs(raw: string | undefined): number {
  const value = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(`[JOB-RUNNER] WORKER_MAX_CONCURRENT=${JSON.stringify(raw ?? null)} is not a positive integer — falling back to ${DEFAULT_MAX_CONCURRENT_JOBS}`)
    return DEFAULT_MAX_CONCURRENT_JOBS
  }
  return value
}

const MAX_CONCURRENT_JOBS = parseMaxConcurrentJobs(process.env.WORKER_MAX_CONCURRENT)
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

const CALLBACK_TIMEOUT_MS = 30_000

/** #928: callback_url 只接受 http/https — 此前任意字符串直接 fetch:
 *  相对路径在 undici 下抛 TypeError 被静默吞掉,畸形 scheme 无意义出网。
 *  校验不过 → 跳过 notify + warn 留痕;补 30s 超时避免挂死连接堆积。 */
function notify(url: string | undefined, body: Record<string, unknown>): void {
  if (!url) return
  if (!/^https?:\/\//i.test(url)) {
    console.warn(`[JOB-RUNNER] callback_url skipped (must be http/https): ${url.slice(0, 200)}`)
    return
  }
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
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
