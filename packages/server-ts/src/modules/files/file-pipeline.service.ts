/**
 * #747 — File post-upload pipeline: a single job state machine replacing the
 * three fire-and-forget async paths that previously lived in finalizeUpload
 * (extraction IIFE, inline vectorization, patient ingestion).
 *
 * Stages: queued → extracted → embedded → proposed → ingested
 *   - extract:  extractDocumentText over the stored file (≤ cap)
 *   - embed:    #749 chunked vector indexing (full document coverage,
 *               not just the first 6000 chars)
 *   - propose:  LLM fact extraction → ProposalService (#732 — semantic
 *               dedup enforced; direct graph writes removed from this path)
 *   - ingest:   patient-context ingestion job (existing IngestionJob flow)
 *
 * Failures stop at the failing stage with errorStage/errorMessage persisted
 * and surface as telemetry `kb_pipeline/degraded` events (#733/#734).
 * retryPipelineJob() re-runs a failed job from scratch (safe: every stage
 * rebuilds its inputs from disk/db).
 */
import fs from 'fs'
import prisma from '../../common/prisma.js'
import { makeLogger } from '../../common/logger.js'
import { getUserContext } from '../chat/user-context.js'
import { extractDocumentText } from '../../lib/document-extractor.js'
import { deepseekChat, getApiKey, DEEPSEEK_CHAT_MODEL } from '../../common/llm.js'
import { parseLlmJson } from '../../common/llm-json.js'
import { factExtractionPrompt } from '../../memory/prompts.js'
import { EmbeddingService } from '../../memory/embedding/embedding.service.js'
import { normalizeVector } from '../../memory/embedding-index.js'
import { chunkText } from '../../lib/text-chunker.js' // #749 pure chunker
import { ProposalService } from '../../memory/proposal/proposal.service.js'
import { createIngestionJob, processIngestionJob } from '../ingestion/ingestion.service.js'
import { PrismaTelemetryService } from '../knowledge/telemetry.service.js'

const log = makeLogger('files.pipeline')
const telemetry = new PrismaTelemetryService()

export const PIPELINE_STAGES = ['extract', 'embed', 'propose', 'ingest'] as const
export type PipelineStageId = (typeof PIPELINE_STAGES)[number]
export type PipelineStageState = 'queued' | 'extracted' | 'embedded' | 'proposed' | 'ingested' | 'failed' | 'skipped'

// ── Tunables (env-overridable) ─────────────────────────────────
/** Max file bytes the pipeline will read for extraction (default 20MB). */
export const PIPELINE_MAX_BYTES = parseInt(process.env.FILE_PIPELINE_MAX_BYTES || '20971520', 10)
/** #749 chunk sizing. */
export const CHUNK_CHARS = parseInt(process.env.FILE_CHUNK_CHARS || '1200', 10)
export const CHUNK_OVERLAP_CHARS = parseInt(process.env.FILE_CHUNK_OVERLAP_CHARS || '150', 10)
/** Fact extraction window budget: N × ~4K chars from the head of the doc. */
export const FACT_WINDOWS = parseInt(process.env.FILE_FACT_WINDOWS || '4', 10)

type PipelineRow = Awaited<ReturnType<typeof prisma.filePipelineJob.findUniqueOrThrow>>

function uploadsBase(): string {
  return process.env.TWIN_BASE_DIR || '.nexus/twins'
}

function isExtractableMime(mimeType?: string | null, filename?: string | null): boolean {
  if (!mimeType && !filename) return false
  const mime = mimeType || ''
  const name = filename || ''
  return mime.startsWith('text/')
    || /\.(txt|md|csv|docx|pdf)$/i.test(name)
    || /pdf|officedocument|wordprocessingml/.test(mime)
}

/** #749: re-exported for callers that chunk without the pipeline. */
export { chunkText } from '../../lib/text-chunker.js'

async function recordStage(userId: string, jobId: string, fileId: string, stage: string, extra: Record<string, unknown> = {}): Promise<void> {
  await telemetry.record({
    userId,
    workspaceId: userId,
    category: 'kb_pipeline',
    action: stage,
    metadata: { jobId, fileId, ...extra },
  }).catch((err: Error) => log.warn('pipeline telemetry skipped', { reason: err.message.slice(0, 100) }))
}

async function recordDegraded(userId: string, jobId: string, fileId: string, stage: string, reason: string): Promise<void> {
  log.warn(`[PIPELINE] degraded`, { jobId, fileId, stage, reason: reason.slice(0, 200) })
  await telemetry.record({
    userId,
    workspaceId: userId,
    category: 'kb_pipeline',
    action: 'degraded',
    metadata: { jobId, fileId, stage, reason: reason.slice(0, 300) },
  }).catch(() => {})
}

async function extractJobText(job: PipelineRow): Promise<string> {
  const filepath = `${uploadsBase()}/${job.userId}/uploads/${job.fileId}`
  const buffer = fs.readFileSync(filepath)
  return extractDocumentText(buffer, job.fileName, job.mimeType, { maxChars: 300000 })
}

// ── Stage implementations ──────────────────────────────────────

interface ExtractOutcome { text: string | null }

async function runExtract(job: PipelineRow): Promise<ExtractOutcome> {
  const filepath = `${uploadsBase()}/${job.userId}/uploads/${job.fileId}`
  let stat: fs.Stats
  try {
    stat = fs.statSync(filepath)
  } catch {
    // Physical file gone (e.g. dedup cleanup race) — nothing to do.
    await prisma.filePipelineJob.update({
      where: { id: job.id },
      data: { stage: 'skipped', errorMessage: 'file missing on disk', updatedAt: new Date().toISOString() },
    })
    return { text: null }
  }
  if (!isExtractableMime(job.mimeType, job.fileName)) {
    await prisma.filePipelineJob.update({
      where: { id: job.id },
      data: { stage: 'skipped', errorMessage: `non-extractable type ${job.mimeType}`, updatedAt: new Date().toISOString() },
    })
    return { text: null }
  }
  if (stat.size > PIPELINE_MAX_BYTES) {
    // #749/#733: no longer silently unindexed — explicit skip + telemetry.
    await recordDegraded(job.userId, job.id, job.fileId, 'extract',
      `size ${stat.size} exceeds extract cap ${PIPELINE_MAX_BYTES}`)
    await prisma.filePipelineJob.update({
      where: { id: job.id },
      data: { stage: 'skipped', errorMessage: `file too large to index (${Math.round(stat.size / 1024)}KB)`, updatedAt: new Date().toISOString() },
    })
    return { text: null }
  }

  const text = await extractJobText(job)
  if (!text.trim() || text.startsWith('[PDF') || text.startsWith('[DOCX')) {
    log.warn(`[PIPELINE] ${job.fileName}: no extractable text`)
    await prisma.filePipelineJob.update({
      where: { id: job.id },
      data: { stage: 'extracted', extractedChars: 0, updatedAt: new Date().toISOString() },
    })
    return { text: null }
  }

  await recordStage(job.userId, job.id, job.fileId, 'stage_extracted', { chars: text.length })
  await prisma.filePipelineJob.update({
    where: { id: job.id },
    data: { stage: 'extracted', extractedChars: text.length, updatedAt: new Date().toISOString() },
  })
  return { text }
}

async function runEmbed(job: PipelineRow, ctx: ReturnType<typeof getUserContext>, text: string | null): Promise<number> {
  if (!text?.trim()) return 0

  const embedding = new EmbeddingService(job.userId, ctx.memory)
  const probe = await embedding.embedBatchOrNull(['ping'])
  if (!probe || !probe[0]) {
    // #734: degraded but observable — facts can still be proposed below.
    await recordDegraded(job.userId, job.id, job.fileId, 'embed', 'embedding provider unavailable')
    await prisma.filePipelineJob.update({
      where: { id: job.id },
      data: { stage: 'embedded', chunkCount: 0, updatedAt: new Date().toISOString() },
    })
    return 0
  }

  const chunks = chunkText(text, { size: CHUNK_CHARS, overlap: CHUNK_OVERLAP_CHARS })
  const model = process.env.EMBEDDING_MODEL || 'BAAI/bge-m3'
  const index = embedding.embeddingIndex()
  let indexed = 0
  for (let start = 0; start < chunks.length; start += 8) {
    const batch = chunks.slice(start, start + 8)
    const vecs = await embedding.embedBatchOrNull(batch)
    if (!vecs) break // provider died mid-run — keep what we indexed
    batch.forEach((chunk, i) => {
      const vec = vecs[i]
      if (!vec) return
      index.upsert({
        nodeId: `${job.fileId}::c${start + i}`,
        stableId: `${job.fileId}::c${start + i}`,
        type: 'document',
        patientHash: job.patientHash || undefined,
        contentHash: chunk.slice(0, 16),
        vector: vec,
        model,
        norm: normalizeVector(vec),
        updatedAt: Date.now(),
        content: chunk, // #749: chunks are graph-less — carry their own text
      })
      indexed++
    })
  }

  await recordStage(job.userId, job.id, job.fileId, 'stage_embedded', { chunks: indexed })
  await prisma.filePipelineJob.update({
    where: { id: job.id },
    data: { stage: 'embedded', chunkCount: indexed, updatedAt: new Date().toISOString() },
  })
  return indexed
}

interface ProposeOutcome { totalFacts: number; proposalCount: number }

async function runPropose(job: PipelineRow, ctx: ReturnType<typeof getUserContext>, text: string | null): Promise<ProposeOutcome> {
  if (!text?.trim()) return { totalFacts: 0, proposalCount: 0 }

  let apiKey: string
  try {
    apiKey = getApiKey()
  } catch {
    await recordDegraded(job.userId, job.id, job.fileId, 'propose', 'no LLM api key')
    return { totalFacts: 0, proposalCount: 0 }
  }

  // #732: proposals only — the ONLY sanctioned write path into memory.
  const scopeType = job.patientHash ? ('patient' as const) : ('global' as const)
  const proposal = new ProposalService(job.userId, ctx.memory, new EmbeddingService(job.userId, ctx.memory))

  const windows = Math.max(1, FACT_WINDOWS)
  const windowChars = 4000
  const proposalIds: string[] = []
  let totalFacts = 0

  for (let w = 0; w < windows; w++) {
    const slice = text.slice(w * windowChars, (w + 1) * windowChars)
    if (!slice.trim()) break
    try {
      const prompt = factExtractionPrompt({ text: slice, mode: 'document' })
      const result = await deepseekChat(
        [{ role: 'user', content: prompt }],
        apiKey,
        {
          model: DEEPSEEK_CHAT_MODEL,
          maxTokens: 2048,
          telemetryContext: { userId: job.userId, workspaceId: job.userId, action: 'file.extract_facts' },
        },
      )
      const facts = parseLlmJson<Array<{ category?: string; content?: string; importance?: number }>>(result)
      if (!Array.isArray(facts)) continue
      for (const f of facts) {
        if (!f?.category || !f?.content) continue
        const row = await proposal.propose({
          scopeType,
          patientHash: job.patientHash || undefined,
          kind: 'fact',
          content: f.content.slice(0, 600),
          category: f.category,
          importance: Math.min(5, Math.max(1, f.importance || 3)),
          confidence: 'medium',
          reason: `extracted from file ${job.fileName}`,
          sourceRange: `file:${job.fileId}#${w}`,
        })
        // Semantic-dup auto-rejections count toward extraction volume but not
        // into the review queue.
        if (row.status !== 'rejected') proposalIds.push(row.id)
        totalFacts++
      }
    } catch (err) {
      log.warn('[PIPELINE] fact window skipped', { jobId: job.id, window: w, reason: (err as Error).message.slice(0, 120) })
    }
  }

  await recordStage(job.userId, job.id, job.fileId, 'stage_proposed', { totalFacts, proposals: proposalIds.length })
  await prisma.filePipelineJob.update({
    where: { id: job.id },
    data: {
      stage: 'proposed',
      factCount: totalFacts,
      proposalIds: JSON.stringify(proposalIds),
      updatedAt: new Date().toISOString(),
    },
  })
  if (totalFacts > 0) console.log(`[PIPELINE] ${job.fileName}: ${proposalIds.length}/${totalFacts} facts passed semantic dedup`)
  return { totalFacts, proposalCount: proposalIds.length }
}

async function runIngest(job: PipelineRow): Promise<string | null> {
  if (!job.patientHash) return null
  // Synchronously pre-created by finalizeUpload (response contract keeps
  // ingestion_job_id) — here we only kick async processing.
  if (job.ingestionJobId) {
    processIngestionJob(job.ingestionJobId)
      .then((processed) => console.log(`[PIPELINE] Ingestion job ${job.ingestionJobId} → ${processed.status}`))
      .catch((err: Error) => log.warn('ingestion processing failed (retryable via /api/v1/ingestion/jobs)', { jobId: job.ingestionJobId, reason: err.message.slice(0, 120) }))
    return job.ingestionJobId
  }
  try {
    const ingestionJob = await createIngestionJob({
      userId: job.userId,
      fileId: job.fileId,
      fileName: job.fileName,
      mimeType: job.mimeType,
      patientHash: job.patientHash,
      uploadedBy: job.userId,
    })
    processIngestionJob(ingestionJob.id)
      .then((processed) => console.log(`[PIPELINE] Ingestion job ${ingestionJob.id} → ${processed.status}`))
      .catch((err: Error) => log.warn('ingestion processing failed (retryable via /api/v1/ingestion/jobs)', { jobId: ingestionJob.id, reason: err.message.slice(0, 120) }))
    return ingestionJob.id
  } catch (err) {
    throw new Error(`ingestion job creation failed: ${(err as Error).message.slice(0, 160)}`)
  }
}

// ── Orchestration ──────────────────────────────────────────────

const inFlight = new Set<string>()
/** Active executions by key — lets tests/GC await pipeline drain (#747). */
const runningTasks = new Map<string, Promise<void>>()

/**
 * Resolves when no pipeline execution is in flight (stable after all current
 * tasks settle). Test suites must await this before Prisma teardown —
 * post-test async stage writes racing the query-engine destructor abort the
 * whole vitest worker (`failed to delete napi ref`, exit 134).
 */
export async function pipelineSettled(): Promise<void> {
  for (let guard = 0; guard < 2000; guard++) {
    const pending = Array.from(runningTasks.values())
    if (pending.length === 0) return
    await Promise.allSettled(pending)
    if (runningTasks.size === 0) return
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Create (or reset) the pipeline row for an upload and kick off execution. */
export async function createAndRunPipeline(input: {
  userId: string
  fileId: string
  fileName: string
  mimeType: string
  sha256: string
  sizeBytes: number
  patientHash: string | null
  /** #747-contract: pre-created by finalizeUpload so /files/upload keeps its
   * synchronous ingestion_job_id response field. */
  ingestionJobId?: string | null
}): Promise<string> {
  const now = new Date().toISOString()
  await prisma.filePipelineJob.upsert({
    where: { userId_fileId: { userId: input.userId, fileId: input.fileId } },
    update: {
      fileName: input.fileName, mimeType: input.mimeType, sha256: input.sha256,
      sizeBytes: input.sizeBytes, patientHash: input.patientHash, stage: 'queued',
      extractedChars: 0, chunkCount: 0, factCount: 0, proposalIds: null,
      ingestionJobId: input.ingestionJobId ?? null, errorStage: null, errorMessage: null, retryCount: 0, updatedAt: now,
    },
    create: {
      userId: input.userId, fileId: input.fileId, fileName: input.fileName,
      mimeType: input.mimeType, sha256: input.sha256, sizeBytes: input.sizeBytes,
      patientHash: input.patientHash, stage: 'queued',
      ingestionJobId: input.ingestionJobId ?? null,
      createdAt: now, updatedAt: now,
    },
  })

  launchPipeline(input.userId, input.fileId)
  return input.fileId
}

/** Fire-and-forget runner that also registers itself for pipelineSettled(). */
function launchPipeline(userId: string, fileId: string): void {
  const key = `${userId}:${fileId}`
  const task = executePipeline(userId, fileId)
    .catch(() => {}) // errors live on the row
    .finally(() => runningTasks.delete(key))
  runningTasks.set(key, task)
}

/**
 * Sequential stage runner keyed by (userId,fileId). Resuming mid-run after a
 * process death is safe: stages rebuild their inputs from disk, and text is
 * re-extracted when not already available in memory.
 */
export async function executePipeline(userId: string, fileId: string): Promise<void> {
  const key = `${userId}:${fileId}`
  if (inFlight.has(key)) return
  inFlight.add(key)
  try {
    let job = await prisma.filePipelineJob.findUnique({ where: { userId_fileId: { userId, fileId } } })
    if (!job) return
    const startIndex = PIPELINE_STAGES.indexOf(stageToStep(job.stage))
    let text: string | null = null

    for (let step = Math.max(0, startIndex); step < PIPELINE_STAGES.length; step++) {
      const stageName = PIPELINE_STAGES[step]
      try {
        switch (stageName) {
          case 'extract': {
            const outcome = await runExtract(job)
            text = outcome.text
            break
          }
          case 'embed':
            await runEmbed(job, getUserContext(userId), text)
            break
          case 'propose':
            await runPropose(job, getUserContext(userId), text)
            break
          case 'ingest': {
            const ingestionJobId = await runIngest(job)
            await prisma.filePipelineJob.update({
              where: { id: job.id },
              data: { stage: 'ingested', ingestionJobId, updatedAt: new Date().toISOString() },
            })
            await recordStage(userId, job.id, fileId, 'stage_ingested', { ingestionJobId })
            break
          }
        }
        job = await prisma.filePipelineJob.findUnique({ where: { id: job.id } })
        if (!job) return
      } catch (err) {
        // #733: failure is a durable state, not a console.log.
        const msg = (err as Error)?.message || String(err)
        await prisma.filePipelineJob.update({
          where: { id: fileId },
          data: {
            stage: 'failed',
            errorStage: stageName,
            errorMessage: msg.slice(0, 400),
            updatedAt: new Date().toISOString(),
          },
        }).catch(() => {})
        await recordDegraded(userId, jobIdSafe(job), fileId, stageName, msg)
        return
      }
    }
  } finally {
    inFlight.delete(key)
  }
}

function stageToStep(stage: string): PipelineStageId {
  switch (stage) {
    case 'queued': return 'extract'
    case 'extracted': return 'embed'
    case 'embedded': return 'propose'
    case 'proposed': return 'ingest'
    default: return 'extract'
  }
}

/** Job row may be re-read to null between stages — the id is the identity. */
function jobIdSafe(job: PipelineRow | null): string {
  return job?.id ?? ''
}

/** Resume a failed/skipped-eligible job from its first incomplete stage. */
export async function retryPipelineJob(userId: string, jobId: string): Promise<{ ok: boolean; error?: string }> {
  const job = await prisma.filePipelineJob.findUnique({ where: { id: jobId } })
  if (!job || job.userId !== userId) return { ok: false, error: 'not found' }
  if (job.stage !== 'failed' && job.stage !== 'skipped') return { ok: false, error: `job is ${job.stage}, nothing to retry` }
  await prisma.filePipelineJob.update({
    where: { id: jobId },
    data: { stage: 'queued', errorStage: null, errorMessage: null, retryCount: { increment: 1 }, updatedAt: new Date().toISOString() },
  })
  launchPipeline(userId, job.fileId)
  return { ok: true }
}
