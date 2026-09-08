/**
 * #820 — 控制面学术渲染服务:sha256 渲染缓存 + FigureRender 溯源模型 +
 * fig_ 图库域收口的拼装层(RENDER_BOUNDARY 铁律:控制面只做校验/缓存/落盘,
 * 渲染在执行面 worker 的 headless Chromium 完成)。
 *
 * 缓存三级(设计 §6):FigureRender 表(DB) → FileIndex(盘) → 前端客户端
 * 渲染。现状 asset-render-pipeline 零缓存恒新文件名落盘 — 本服务是首个
 * 真正内容寻址的渲染入口:同 (userId, sha256) 二次请求直接命中,不重复
 * enqueue(测试锁定)。
 *
 * 重渲染语义:同 source 新 options → 新 sha256 → 新产物,旧产物保留
 * (版本不覆盖,对齐 #811 重下载语义)。
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import prisma from '../../common/prisma.js'
import { makeLogger } from '../../common/logger.js'
import { issueChartToken } from '../../common/chart-token.js'
import { createExecutionPlaneService } from '../execution/execution-plane.service.js'
import { pollRenderJob } from '../../tools/asset-render-pipeline.js'
import { uploadsBaseDir } from '../../lib/upload-path.js'

const log = makeLogger('figures.figure-service')

/** 单图渲染轮询预算 — 同步导出降级路径依赖此预算(#821)。 */
const RENDER_WAIT_MS = 15_000
const POLL_INTERVAL_MS = 500

/**
 * #928: (userId, sha256) → in-flight 渲染 promise — 并发同源请求此前各自
 * 走完整 miss 路径,双 enqueue + 双落盘(两个 fig_ 文件/两条 FigureRender)。
 * 同 key 并发合并为一次渲染(inflight 模式参照 tools/external-fetch.ts);
 * promise 结算后自清,失败不缓存,下次重试照常。
 */
const inflightFigures = new Map<string, Promise<{ ok: true; file: FigureFile } | { ok: false; reason: string }>>()

export interface FigureInput {
  kind: 'mermaid' | 'latex_math'
  source: string
  display?: boolean
  theme?: string
  scale?: number
}

export interface FigureFile {
  /** true = FigureRender 缓存命中(未重新 enqueue)。 */
  cached: boolean
  fileId: string
  /** 嵌入用 URL(带短时 chart-token,img 标签可带)。 */
  url: string
  width?: number
  height?: number
}

export function figureSha256(input: FigureInput): string {
  const optionsJson = JSON.stringify({ display: input.display, theme: input.theme, scale: input.scale })
  return crypto.createHash('sha256').update(`${input.kind}\n${optionsJson}\n${input.source}`).digest('hex')
}

function uploadsDir(userId: string): string {
  return uploadsBaseDir(userId)
}

function buildPayload(input: FigureInput): Record<string, unknown> {
  const payload: Record<string, unknown> = { kind: input.kind, source: input.source }
  if (input.display !== undefined) payload.display = input.display
  if (input.theme !== undefined) payload.theme = input.theme
  if (input.scale !== undefined) payload.scale = input.scale
  return payload
}

/** miss 路径:enqueue → 轮询 → fetchFile → 落盘 + FileIndex + FigureRender。 */
async function renderFigureMiss(userId: string, input: FigureInput, sha256: string, startedAt: number): Promise<{ ok: true; file: FigureFile } | { ok: false; reason: string }> {
  // 渲染在执行面(worker Chromium),控制面只编排。
  const plane = createExecutionPlaneService()
  const job = await plane.enqueue({ type: 'sidecar.render_figure', payload: buildPayload(input), tenant: { userId } })
  const final = await pollRenderJob(plane, job.job_id, RENDER_WAIT_MS, POLL_INTERVAL_MS)
  if (!final) return { ok: false, reason: 'figure render timed out' }
  if (final.status !== 'completed') {
    const reason = String(final.error || (final.result as any)?.error || final.status)
    return { ok: false, reason: reason.slice(0, 200) }
  }
  const workerFileId = (final.result as any)?.file_id as string | undefined
  if (!workerFileId) return { ok: false, reason: 'figure render produced no file' }

  const bytes = await plane.fetchFile?.(workerFileId)
  if (!bytes || bytes.length === 0) return { ok: false, reason: 'figure fetch empty' }

  // 落盘 + FileIndex(下载/图库域)。fig_ 前缀 → 图库域,知识库列表排除。
  const hash8 = sha256.slice(0, 8)
  const dir = uploadsDir(userId)
  fs.mkdirSync(dir, { recursive: true })
  const localFileId = `fig_${input.kind}_${hash8}_${Date.now()}.svg`
  fs.writeFileSync(path.join(dir, localFileId), bytes)
  const now = new Date().toISOString()
  await prisma.fileIndex.upsert({
    where: { id: localFileId },
    create: {
      id: localFileId, userId, name: `figure_${hash8}.svg`, mime: 'image/svg+xml',
      sizeBytes: bytes.length, sha256, createdAt: now, updatedAt: now,
    },
    update: {},
  }).catch((err: Error) => log.warn('figure fileIndex persist skipped', { reason: err.message.slice(0, 100) }))

  // FigureRender 溯源记录(源码留存,支撑图库查看源码/重渲染)。
  try {
    await prisma.figureRender.create({
      data: {
        userId, kind: input.kind, source: input.source,
        optionsJson: JSON.stringify({ display: input.display, theme: input.theme, scale: input.scale }),
        sha256, svgFileId: localFileId,
        width: (final.result as any)?.width ?? null,
        height: (final.result as any)?.height ?? null,
        renderedMs: Date.now() - startedAt,
        createdAt: now, updatedAt: now,
      },
    })
  } catch (err) {
    // 记录失败不回滚产物(文件已落盘可用);下次同源码会重渲染一次。
    log.warn('figureRender record skipped', { reason: (err as Error).message.slice(0, 120) })
  }

  return {
    ok: true,
    file: {
      cached: false,
      fileId: localFileId,
      url: `/api/v1/files/download/${localFileId}?token=${issueChartToken(localFileId, userId)}`,
      width: (final.result as any)?.width ?? undefined,
      height: (final.result as any)?.height ?? undefined,
    },
  }
}

/**
 * 内容寻位的渲染入口。命中 FigureRender 缓存直接返回;miss 则
 * enqueue sidecar.render_figure → 轮询 → fetchFile → 落盘
 * `fig_{kind}_{hash8}_{ts}.svg` + FileIndex upsert + FigureRender 记录。
 * force=true 跳过缓存强制重渲染(渲染器升级后旧产物刷新用)。
 * #928: 非 force 的并发同 (userId, sha256) 请求合并到同一 in-flight promise。
 */
export async function ensureFigure(userId: string, input: FigureInput, opts: { force?: boolean } = {}): Promise<{ ok: true; file: FigureFile } | { ok: false; reason: string }> {
  const sha256 = figureSha256(input)
  const startedAt = Date.now()

  if (opts.force) return renderFigureMiss(userId, input, sha256, startedAt)

  // L1 — FigureRender 表(DB):同源码不重复渲染。
  try {
    const cached = await prisma.figureRender.findUnique({
      where: { userId_sha256: { userId, sha256 } },
    })
    if (cached) {
      return {
        ok: true,
        file: {
          cached: true,
          fileId: cached.svgFileId,
          url: `/api/v1/files/download/${cached.svgFileId}?token=${issueChartToken(cached.svgFileId, userId)}`,
          width: cached.width ?? undefined,
          height: cached.height ?? undefined,
        },
      }
    }
  } catch (err) {
    log.warn('figure cache lookup skipped', { reason: (err as Error).message.slice(0, 120) })
  }

  // #928: in-flight 合并 — 首个请求创建 promise,后续并发请求等同一结果。
  const key = `${userId}:${sha256}`
  const pending = inflightFigures.get(key)
  if (pending) return pending
  const job = renderFigureMiss(userId, input, sha256, startedAt)
    .finally(() => { inflightFigures.delete(key) })
  inflightFigures.set(key, job)
  return job
}

/** 批量预热(#821 保存钩子用)— 同批去重后逐个 ensure,失败项跳过。 */
export async function ensureFigures(userId: string, inputs: FigureInput[]): Promise<Array<{ input: FigureInput; result: Awaited<ReturnType<typeof ensureFigure>> }>> {
  const seen = new Set<string>()
  const out: Array<{ input: FigureInput; result: Awaited<ReturnType<typeof ensureFigure>> }> = []
  for (const input of inputs) {
    const key = figureSha256(input)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ input, result: await ensureFigure(userId, input).catch((err: Error) => ({ ok: false as const, reason: err.message.slice(0, 200) })) })
  }
  return out
}

/** 查渲染记录(图库"查看源码/重渲染"用)。 */
export async function getFigureRenderByFileId(userId: string, svgFileId: string) {
  return prisma.figureRender.findFirst({ where: { userId, svgFileId }, orderBy: { createdAt: 'desc' } })
}
