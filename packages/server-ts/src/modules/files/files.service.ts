/**
 * Files service — upload finalize pipeline (dedup → fact extraction →
 * embedding → ingestion) and chunked-upload storage helpers.
 *
 * Extracted from files.router.ts (#681): the router now only maps HTTP to
 * these operations; LLM/embedding/memory concerns live here, not in the
 * route layer.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import prisma from '../../common/prisma'
import { getUserContext } from '../chat/user-context.js'
import { sanitizeFilename } from '../../lib/upload-path.js'
import { extractDocumentText } from '../../lib/document-extractor.js'
import { deepseekChat, getApiKey, DEEPSEEK_CHAT_MODEL } from '../../common/llm.js'
import { parseLlmJson } from '../../common/llm-json.js'
import { factExtractionPrompt } from '../../memory/prompts.js'
import { createIngestionJob, processIngestionJob } from '../ingestion/ingestion.service.js'

// ── Upload limits & paths ─────────────────────────────────────

export const uploadsDir = (userId: string) => path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
export const chunkDir = (userId: string, uploadId: string) => path.join(uploadsDir(userId), '.tmp', uploadId)

// #fix: 分片上传 — 大文件(>100MB 单请求上限)拆成分片逐段上传,避免
// 单请求体积/内存峰值问题。
export const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{8,128}$/
export const MAX_CHUNKS = 2048
export const CHUNK_MAX_BYTES = parseInt(process.env.UPLOAD_CHUNK_MAX_BYTES || '32', 10) * 1024 * 1024
export const MAX_CHUNKED_TOTAL_BYTES = parseInt(process.env.MAX_CHUNKED_UPLOAD_BYTES || '2048', 10) * 1024 * 1024
export const MAX_FACT_EXTRACT_BYTES = 500 * 1024

export async function findDedup(userId: string, sha256: string) {
  try {
    return await (prisma as any).fileIndex.findFirst({ where: { userId, sha256 } })
  } catch {
    return null
  }
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
 * 单次上传与分片上传共用的收尾:事实提取 + 向量索引 + 文件索引 + 摄入。
 * Fact extraction/embedding failures are best-effort (never block upload).
 */
export async function finalizeUpload(input: FinalizeUploadInput): Promise<FinalizedUpload> {
  const { userId, fileId, filename, mimeType, sha256, sizeBytes, patientHash } = input
  const filepath = path.join(uploadsDir(userId), fileId)

  // #628: 提取事实从 txt/md 放开到 docx/pdf/csv — 统一走
  // extractDocumentText(文本直接读、docx 经 mammoth、pdf 经 pdf-parse)。
  // 大小上限放宽至 500KB;超大文件降级跳过(不阻塞上传流程)。
  const isExtractable = mimeType?.startsWith('text/')
    || /\.(txt|md|csv|docx|pdf)$/i.test(filename || '')
  const ctx = getUserContext(userId)
  const docNode = ctx.memory.addDocument({
    fileId,
    sha256,
    name: filename,
    mimeType: mimeType || 'application/octet-stream',
    patientHash: patientHash || undefined,
  })
  if (isExtractable && sizeBytes <= MAX_FACT_EXTRACT_BYTES) {
    ;(async () => {
      try {
        // 大文件不整读进内存:仅 ≤500KB 的小文件做事实提取/向量化。
        const buffer = fs.readFileSync(filepath)
        // #632: 一次提取全文 — fact 提取 prompt 用前 4K,embedding 用全文。
        const text = await extractDocumentText(buffer, filename, mimeType, { maxChars: 30000 })
        if (!text.trim() || text.startsWith('[PDF') || text.startsWith('[DOCX')) {
          console.log(`[FILE] ${filename} returned no extractable text — fact extraction skipped`)
          return
        }
        // #632: document 正文入向量索引(embedding 故障自动跳过,不阻塞上传)。
        const { EmbeddingService } = await import('../../memory/embedding/embedding.service.js')
        await new EmbeddingService(userId).indexApproved({
          nodeId: docNode.id,
          stableId: docNode.stableId,
          type: 'document',
          content: text.slice(0, 6000),
          patientHash: patientHash || undefined,
        })
        const apiKey = getApiKey()
        const prompt = factExtractionPrompt({ text: text.slice(0, 4000), mode: 'document' })
        const result = await deepseekChat(
          [{ role: 'user', content: prompt }],
          apiKey,
          {
            model: DEEPSEEK_CHAT_MODEL,
            maxTokens: 2048,
            telemetryContext: {
              userId,
              workspaceId: userId,
              action: 'file.extract_facts',
            },
          },
        )
        const facts = parseLlmJson<Array<{
          category: 'fact' | 'preference' | 'constraint' | 'goal' | 'context'
          content: string
          importance?: number
          sourceType: 'patient' | 'doctor' | 'research' | 'general'
        }>>(result)
        let added = 0
        if (Array.isArray(facts)) {
          for (const f of facts) {
            if (f.category && f.content) {
              const factNode = ctx.memory.addFact({
                category: f.category,
                importance: Math.min(5, Math.max(1, f.importance || 3)),
                content: f.content,
                sourceType: f.sourceType || 'research',
                patientHash: patientHash || undefined,
                provenance: { sourceKind: 'document', sourceRef: fileId },
              })
              ctx.memory.graph.addRelation({
                id: `rel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                sourceId: docNode.id,
                targetId: factNode.id,
                relation: 'derives_from',
                createdAt: Date.now(),
              })
              added++
            }
          }
          ctx.memory.graph.commit()
          if (added > 0) { console.log(`[FILE] Extracted ${added} facts from ${filename}`) }
        }
      } catch (err) { console.log('[FILE] Fact extraction skipped:', (err as Error).message.slice(0, 80)) }
    })()
  } else if (isExtractable && sizeBytes > MAX_FACT_EXTRACT_BYTES) {
    console.log(`[FILE] ${filename} (${sizeBytes} bytes) exceeds fact-extract size cap — skipped, upload unaffected`)
  }

  // Persist file index for dedup + listing
  try {
    await (prisma as any).fileIndex.upsert({
      where: { sha256_userId: { sha256, userId } },
      update: { name: filename, sizeBytes, updatedAt: new Date().toISOString() },
      create: {
        id: fileId, userId, sha256,
        name: filename, mime: mimeType, sizeBytes,
        patientHash: patientHash || null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    })
  } catch {
    // FileIndex table may not exist yet; continue without dedup persistence
  }

  // Kick off AI ingestion (analyze → pending_review entries) when the file is
  // uploaded in a patient context. Runs fire-and-forget; failures leave the
  // job in a retryable/failed state visible via /api/v1/ingestion/jobs.
  let ingestionJobId: string | null = null
  let ingestionStatus: string | null = null
  if (patientHash) {
    try {
      const job = await createIngestionJob({
        userId,
        fileId,
        fileName: filename,
        mimeType: mimeType || 'application/octet-stream',
        patientHash,
        uploadedBy: userId,
      })
      ingestionJobId = job.id
      ingestionStatus = job.status
      processIngestionJob(job.id)
        .then((processed) => console.log(`[FILE] Ingestion job ${job.id} → ${processed.status}`))
        .catch((err: Error) => console.log('[FILE] Ingestion processing skipped:', err.message.slice(0, 80)))
    } catch (err) {
      console.log('[FILE] Ingestion job creation skipped:', (err as Error).message.slice(0, 80))
    }
  }

  return {
    file_id: fileId,
    name: filename,
    mime: mimeType,
    size_bytes: sizeBytes,
    patient_hash: patientHash || null,
    dedup: false,
    ingestion_job_id: ingestionJobId,
    ingestion_status: ingestionStatus,
  }
}

/** Generated file ids look like `scene_*` / `chart_*` (render output). */
export function isGeneratedFileId(fileId: string): boolean {
  return fileId.startsWith('scene_') || fileId.startsWith('chart_')
}

export function newFileId(filename: string): string {
  return `${Date.now()}_${sanitizeFilename(filename)}`
}

export function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}
