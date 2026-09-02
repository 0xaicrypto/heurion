/**
 * Files service — upload finalize: dedup claim (race-safe) → post-upload
 * pipeline kickoff → chunked-upload storage helpers.
 *
 * Extracted from files.router.ts (#681): the router now only maps HTTP to
 * these operations; LLM/embedding/memory concerns live in the pipeline
 * (file-pipeline.service.ts), not in the route layer.
 *
 * #730/#746: FileIndex is a first-class model — typed access, no
 * `(prisma as any)` and no silent catch. Missing table = startup failure
 * (see main.ts assertSchema), never silent degradation.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import prisma from '../../common/prisma.js'
import { sanitizeFilename } from '../../lib/upload-path.js'
import { createAndRunPipeline } from './file-pipeline.service.js'
import { makeLogger } from '../../common/logger.js'

const log = makeLogger('files')

// ── Upload limits & paths ─────────────────────────────────────

export const uploadsDir = (userId: string) => path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
export const chunkDir = (userId: string, uploadId: string) => path.join(uploadsDir(userId), '.tmp', uploadId)

// #fix: 分片上传 — 大文件(>100MB 单请求上限)拆成分片逐段上传,避免
// 单请求体积/内存峰值问题。
export const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{8,128}$/
export const MAX_CHUNKS = 2048
export const CHUNK_MAX_BYTES = parseInt(process.env.UPLOAD_CHUNK_MAX_BYTES || '32', 10) * 1024 * 1024
export const MAX_CHUNKED_TOTAL_BYTES = parseInt(process.env.MAX_CHUNKED_UPLOAD_BYTES || '2048', 10) * 1024 * 1024

/**
 * Fast-path dedup lookup for the router. Returns the live index row when an
 * identical file (same sha256, same user) already exists on disk; callers may
 * respond `dedup: true` without persisting anything.
 */
export async function findDedup(userId: string, sha256: string) {
  const existing = await prisma.fileIndex.findFirst({ where: { userId, sha256 } })
  if (!existing || existing.deletedAt) return null
  // Index points at a deleted/renamed physical file → treat as no dedup and
  // let the claim below take the row over with fresh metadata.
  try { fs.accessSync(path.join(uploadsDir(userId), existing.id)) } catch { return null }
  return existing
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as any).code === 'P2002'
}

export interface FinalizeUploadInput {
  userId: string
  fileId: string
  filename: string
  mimeType: string
  sha256: string
  sizeBytes: number
  patientHash: string | null
}

export interface FinalizedUpload {
  file_id: string
  name: string
  mime: string
  size_bytes: number
  patient_hash: string | null
  dedup: boolean
  ingestion_job_id: string | null
  ingestion_status: string | null
}

/**
 * Claim ownership of the (userId,sha256) slot with TOCTOU safety:
 *
 *   find alive row referencing an on-disk file?  → return it as dedup hit,
 *   otherwise try to CREATE our row. A P2002 unique violation means a
 *   concurrent upload of the same content won the race — re-read the winner:
 *     - winner is live with a real file → we are the duplicate
 *     - winner is stale/deleted        → replace it and take over
 */
async function claimFileIndex(input: FinalizeUploadInput): Promise<{ fileId: string; dedup: boolean }> {
  const fast = await findDedup(input.userId, input.sha256)
  if (fast) return { fileId: fast.id, dedup: true }

  const now = new Date().toISOString()
  const createData = {
    id: input.fileId,
    userId: input.userId,
    sha256: input.sha256,
    name: input.filename,
    mime: input.mimeType,
    sizeBytes: input.sizeBytes,
    patientHash: input.patientHash,
    createdAt: now,
    updatedAt: now,
  }
  try {
    await prisma.fileIndex.create({ data: createData })
    return { fileId: input.fileId, dedup: false }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    // Concurrent winner — re-read and reconcile.
    const winner = await prisma.fileIndex.findFirst({
      where: { userId: input.userId, sha256: input.sha256 },
      orderBy: { createdAt: 'asc' },
    })
    const winnerAlive = winner && !winner.deletedAt
      && (() => { try { fs.accessSync(path.join(uploadsDir(input.userId), winner!.id)); return true } catch { return false } })()
    if (winner && winnerAlive) return { fileId: winner.id, dedup: true }
    if (winner) {
      // Stale row (deleted content): swap it for ours.
      await prisma.fileIndex.delete({ where: { id: winner.id } }).catch(() => {})
    }
    await prisma.fileIndex.create({ data: createData })
    return { fileId: input.fileId, dedup: false }
  }
}

/**
 * 单次上传与分片上传共用的收尾:dedup 认领 + 管线启动(extract→embed→
 * propose→ingest)。Fact extraction / embedding failures never block upload —
 * they are durable states on the FilePipelineJob row (#733).
 */
export async function finalizeUpload(input: FinalizeUploadInput): Promise<FinalizedUpload> {
  const { userId, filename, mimeType, sha256, sizeBytes, patientHash } = input

  const claim = await claimFileIndex(input)
  if (claim.dedup) {
    // Remove the physical file we just wrote — the winner's copy stays.
    const filepath = path.join(uploadsDir(userId), input.fileId)
    fs.rmSync(filepath, { force: true })
    // Mirror cleanup: chunked uploads leave their temp dir behind too.
    return {
      file_id: claim.fileId,
      name: filename,
      mime: mimeType,
      size_bytes: sizeBytes,
      patient_hash: patientHash,
      dedup: true,
      ingestion_job_id: null,
      ingestion_status: null,
    }
  }

  // Graph DocumentNode must exist immediately (picker / picked_kb list
  // documents from the in-memory graph); original text stays on disk and is
  // extracted on demand (#628 contract).
  const { getUserContext } = await import('../chat/user-context.js')
  getUserContext(userId).memory.addDocument({
    fileId: input.fileId,
    sha256,
    name: filename,
    mimeType: mimeType || 'application/octet-stream',
    patientHash: patientHash || undefined,
  })

  // Post-processing pipeline (stateful, retryable, observable).
  // Patient-scope ingestion job is created synchronously so the upload
  // response keeps its ingestion_job_id field (existing API contract);
  // processing stays async inside the pipeline's ingest stage.
  let ingestionJobId: string | null = null
  let ingestionStatus: string | null = null
  try {
    if (patientHash) {
      const { createIngestionJob } = await import('../ingestion/ingestion.service.js')
      const job = await createIngestionJob({
        userId,
        fileId: input.fileId,
        fileName: filename,
        mimeType: mimeType || 'application/octet-stream',
        patientHash,
        uploadedBy: userId,
      })
      ingestionJobId = job.id
      ingestionStatus = job.status
    }
    await createAndRunPipeline({
      userId,
      fileId: input.fileId,
      fileName: filename,
      mimeType: mimeType || 'application/octet-stream',
      sha256,
      sizeBytes,
      patientHash,
      ingestionJobId,
    })
  } catch (err) {
    log.info('[FILE] Pipeline kickoff failed:', (err as Error).message.slice(0, 120))
  }

  return {
    file_id: input.fileId,
    name: filename,
    mime: mimeType,
    size_bytes: sizeBytes,
    patient_hash: patientHash,
    dedup: false,
    ingestion_job_id: ingestionJobId,
    ingestion_status: ingestionStatus,
  }
}

/** Generated file ids look like `scene_*` / `chart_*` / `img_*` (AI render
 *  output — #811 图库与知识库域分离的判别键)。 */
export function isGeneratedFileId(fileId: string): boolean {
  return fileId.startsWith('scene_') || fileId.startsWith('chart_') || fileId.startsWith('img_')
}

export function newFileId(filename: string): string {
  return `${Date.now()}_${sanitizeFilename(filename)}`
}

export function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

// ── #700: chunked-upload merge — 上传收尾逻辑单点化 ─────────────────
// 此前「校验分片齐全 → 顺序合并+流式 sha256 → 体积上限 → 去重 → 搬运 →
// 清理 → finalize」70 行内联在 router,与单次上传的两套口径并存。现在
// service 提供唯一入口,router 只剩参数校验与 HTTP 映射。

export type CompleteChunkedResult =
  | { status: 400; error: string }
  | { status: 413; error: string }
  | { status: 200; payload: FinalizedUpload | DedupUploadPayload }

/** 去重命中的响应形状(不含 ingestion 字段 — 与既有 API 契约一致)。 */
export interface DedupUploadPayload {
  file_id: string
  name: string
  mime: string
  size_bytes: number
  patient_hash: string | null
  dedup: true
}

/**
 * 单次上传收尾(去重 → 落盘 → finalize)— router 只留 multipart 解析。
 */
export async function completeSimpleUpload(input: {
  userId: string
  filename: string
  mimeType: string
  buffer: Buffer
  patientHash: string | null
}): Promise<FinalizedUpload | DedupUploadPayload> {
  const { userId, filename, mimeType, buffer, patientHash } = input
  const sha256 = sha256Hex(buffer)
  const dir = uploadsDir(userId)
  fs.mkdirSync(dir, { recursive: true })

  const existing = await findDedup(userId, sha256)
  if (existing) {
    return {
      file_id: existing.id,
      name: filename,
      mime: mimeType,
      size_bytes: existing.sizeBytes,
      patient_hash: patientHash || existing.patientHash || null,
      dedup: true,
    }
  }

  const fileId = newFileId(filename)
  fs.writeFileSync(path.join(dir, fileId), buffer)
  return finalizeUpload({
    userId,
    fileId,
    filename,
    mimeType,
    sha256,
    sizeBytes: buffer.length,
    patientHash,
  })
}

/**
 * 分片上传收尾(与单次上传同口径):
 *   1. 会话与分片齐全性校验(缺失 → 400)
 *   2. 顺序合并 + 流式 sha256(分片单独落盘,不整读进内存)
 *   3. 总体积上限(超限 → 413,清理临时目录)
 *   4. 合并后去重(命中 → 清理临时目录,返回 dedup 形状)
 *   5. 搬入 uploads 目录 + 清理 .tmp 会话 → finalizeUpload(去重认领 +
 *      图谱 DocumentNode + 管线启动)
 */
export async function completeChunkedUpload(input: {
  userId: string
  uploadId: string
  filename: string
  mimeType: string
  total: number
  patientHash: string | null
}): Promise<CompleteChunkedResult> {
  const { userId, uploadId, filename, mimeType, total, patientHash } = input
  const dir = chunkDir(userId, uploadId)
  if (!fs.existsSync(dir)) {
    return { status: 400, error: 'Upload session not found — upload chunks first' }
  }
  for (let i = 1; i <= total; i++) {
    const chunkPath = path.join(dir, `chunk_${String(i).padStart(6, '0')}`)
    if (!fs.existsSync(chunkPath)) {
      return { status: 400, error: `Missing chunk ${i}/${total}` }
    }
  }

  const tmpMerged = path.join(dir, 'merged')
  const hash = crypto.createHash('sha256')
  let sizeBytes = 0
  const out = fs.createWriteStream(tmpMerged)
  await new Promise<void>((resolve, reject) => {
    out.on('error', reject)
    for (let i = 1; i <= total; i++) {
      const buf = fs.readFileSync(path.join(dir, `chunk_${String(i).padStart(6, '0')}`))
      hash.update(buf)
      sizeBytes += buf.length
      out.write(buf)
    }
    out.end(() => resolve())
  })
  const sha256 = hash.digest('hex')

  if (sizeBytes > MAX_CHUNKED_TOTAL_BYTES) {
    fs.rmSync(dir, { recursive: true, force: true })
    return { status: 413, error: `分片总大小超过 ${Math.round(MAX_CHUNKED_TOTAL_BYTES / 1024 / 1024)}MB 上限` }
  }

  const existing = await findDedup(userId, sha256)
  if (existing && !existing.deletedAt) {
    fs.rmSync(dir, { recursive: true, force: true })
    return {
      status: 200,
      payload: {
        file_id: existing.id,
        name: filename,
        mime: mimeType,
        size_bytes: existing.sizeBytes,
        patient_hash: patientHash || existing.patientHash || null,
        dedup: true,
      } satisfies DedupUploadPayload,
    }
  }

  const fileId = newFileId(filename)
  fs.renameSync(tmpMerged, path.join(uploadsDir(userId), fileId))
  fs.rmSync(dir, { recursive: true, force: true })

  const finalized = await finalizeUpload({
    userId,
    fileId,
    filename,
    mimeType,
    sha256,
    sizeBytes,
    patientHash,
  })
  return { status: 200, payload: finalized }
}
