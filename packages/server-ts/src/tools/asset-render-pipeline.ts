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

/** #820: 轮询导出 — figure.service 复用同一轮询语义(30s/1s 节奏一致)。 */
export function pollRenderJob(plane: ToolExecutionPlane, jobId: string, maxWaitMs: number, intervalMs: number): Promise<{ status: string; error?: unknown; result?: Record<string, unknown> } | null> {
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
  /** 落盘扩展名(png/docx/pptx/pdf)。SVG 字节会自动改判为 svg(#823)。 */
  ext: string
  /** 落盘文件 id 前缀(plot_/export_)。 */
  prefix: string
  docId: string
  /** 下载卡片展示名(标题净化);png 路径传空。 */
  displayBase: string
  maxWaitMs?: number
}): Promise<RenderJobOutcome> {
  const { plane, userId, jobType, payload, ext: requestedExt, prefix, docId, displayBase } = input
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

  // #823: SVG 字节绝不能按位图扩展名直嵌(asset-embed #fix 2026-09 同源
  // 教训:plot_*.png 里装的其实是 worker 的 chart.svg,Word/PPT 按位图
  // 解析 → 中文方块)。按字节魔数判定,SVG 诚实落 .svg — 嵌入侧
  // (asset-embed.resolveLocalImageBlock / loadExportImage)已有 SVG→PNG
  // 光栅化路径,位图需求在嵌入时满足。
  const head = bytes.subarray(0, 512).toString('utf-8').trimStart()
  const ext = head.startsWith('<svg') || head.startsWith('<?xml') ? 'svg' : requestedExt

  const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
  fs.mkdirSync(dir, { recursive: true })
  const localFileId = `${prefix}_${docId}_${Date.now()}.${ext}`
  const fileName = ext === 'png' || ext === 'svg' ? localFileId : `${displayBase || 'export'}.${ext}`
  fs.writeFileSync(path.join(dir, localFileId), bytes)
  const token = issueChartToken(localFileId, userId)
  // 双 PDF 轨道收敛点标记(#821):本函数是管线 B(worker pdfkit)的产物
  // 落盘点;管线 A(server-ts pdfkit)在 documents/markdown-export.ts。
  // 两条轨各自做 SVG→sharp→PNG 嵌入,待 #824 评估后统一。
  return { ok: true, file: { localFileId, fileName, url: `/api/v1/files/download/${localFileId}?token=${token}` } }
}
