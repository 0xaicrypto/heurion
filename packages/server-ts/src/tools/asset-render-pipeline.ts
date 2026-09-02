/**
 * Asset render pipeline (#789②) — the shared "enqueue → poll → fetch →
 * store → tokenized URL" path for plot/export render jobs, extracted from
 * insert-asset-tool.ts. Callers keep only their payload/contract specifics
 * and map the discriminated failure kinds to user-facing messages.
 */
import fs from 'fs'
import path from 'path'
import type { ToolExecutionPlane } from './tool-registry.js'
import { issueChartToken } from '../common/chart-token.js'

export type RenderJobOutcome =
  | { ok: true; file: RenderedFile }
  | { ok: false; kind: 'timeout'; jobId: string }
  | { ok: false; kind: 'failed'; reason: string }
  | { ok: false; kind: 'no_file' }
  | { ok: false; kind: 'fetch_empty' }

export interface RenderedFile {
  localFileId: string
  fileName: string
  url: string
}

function pollRenderJob(plane: ToolExecutionPlane, jobId: string, maxWaitMs: number, intervalMs: number): Promise<{ status: string; error?: unknown; result?: Record<string, unknown> } | null> {
  const deadline = Date.now() + maxWaitMs
  return (async () => {
    while (Date.now() < deadline) {
      const status = await plane.getStatus(jobId)
      if (status && status.status !== 'pending' && status.status !== 'running') return status
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    return null
  })()
}

/**
 * 渲染任务全链路：enqueue → 轮询终态 → fetchFile → 落盘 uploads →
 * issueChartToken 下载 URL。plot/export 两条路径共用。
 */
export async function runRenderJob(input: {
  plane: ToolExecutionPlane
  userId: string
  jobType: 'sidecar.render_plot' | 'sidecar.generate_docx' | 'sidecar.generate_pptx' | 'sidecar.convert_to_pdf'
  payload: Record<string, unknown>
  /** 落盘扩展名(png/docx/pptx/pdf)。 */
  ext: string
  /** 落盘文件 id 前缀(plot_/export_)。 */
  prefix: string
  docId: string
  /** 下载卡片展示名(标题净化);png 路径传空。 */
  displayBase: string
  maxWaitMs?: number
}): Promise<RenderJobOutcome> {
  const { plane, userId, jobType, payload, ext, prefix, docId, displayBase } = input
  const job = await plane.enqueue({ type: jobType, payload, tenant: { userId } })
  const final = await pollRenderJob(plane, job.job_id, input.maxWaitMs ?? 30000, 1000)
  if (!final) return { ok: false, kind: 'timeout', jobId: job.job_id }
  if (final.status !== 'completed') {
    const reason = String(final.error || (final.result as any)?.error || final.status)
    return { ok: false, kind: 'failed', reason: reason.slice(0, 200) }
  }
  const fileId = (final.result as any)?.file_id as string | undefined
  if (!fileId) return { ok: false, kind: 'no_file' }

  const bytes = await plane.fetchFile?.(fileId)
  if (!bytes || bytes.length === 0) return { ok: false, kind: 'fetch_empty' }

  const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
  fs.mkdirSync(dir, { recursive: true })
  const localFileId = `${prefix}_${docId}_${Date.now()}.${ext}`
  const fileName = ext === 'png' ? localFileId : `${displayBase || 'export'}.${ext}`
  fs.writeFileSync(path.join(dir, localFileId), bytes)
  const token = issueChartToken(localFileId, userId)
  return { ok: true, file: { localFileId, fileName, url: `/api/v1/files/download/${localFileId}?token=${token}` } }
}
