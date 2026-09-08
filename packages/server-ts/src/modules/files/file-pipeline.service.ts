import { resolveTierModel } from '../../common/llm-gateway.js'
import { twinsRoot } from '../../lib/upload-path.js'
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
import { getUserContext } from '../shared/user-context.js'
import { extractDocumentText } from '../../lib/document-extractor.js'
import { deepseekChat, getApiKey} from '../../common/llm.js'
import { parseLlmJson } from '../../common/llm-json.js'
import { factExtractionPrompt } from '../../memory/prompts.js'
import { EmbeddingService } from '../../memory/embedding/embedding.service.js'
import { normalizeVector } from '../../memory/embedding-index.js'
import { chunkText } from '../../lib/text-chunker.js' // #749 pure chunker
import { buildSectionWindows } from '../../lib/section-windows.js' // 章节感知 fact 窗口
import { ProposalService } from '../../memory/proposal/proposal.service.js'
import { createIngestionJob, processIngestionJob } from '../ingestion/ingestion.service.js'
import { PrismaTelemetryService } from '../knowledge/telemetry.service.js'
// #790: 阶段枚举 + 可提取能力判定接入 contracts 单一来源（此前契约
// 上线即零消费、server 手写同款 union）。
import { FILE_PIPELINE_STAGES, KB_EXTRACTABLE_EXTENSIONS, type FilePipelineStage } from '@heurion/contracts'
import { isExtractionSentinel } from '../../lib/document-extractor.js'

const slog = makeLogger('files.pipeline')

const log = makeLogger('files.pipeline')
const telemetry = new PrismaTelemetryService()

export const PIPELINE_STAGES = ['extract', 'embed', 'propose', 'ingest'] as const
export type PipelineStageId = (typeof PIPELINE_STAGES)[number]
export type PipelineStageState = FilePipelineStage

// #788: 转移表 — 6 处散落的 stage 直写收敛到 transitionStage 单点。
// 终态(ingested/failed/skipped)不可再转移;retry 是显式重置,直接写 queued。
const ALLOWED_TRANSITIONS: Record<PipelineStageState, readonly PipelineStageState[]> = {
  queued: ['extracted', 'skipped', 'failed'],
  extracted: ['embedded', 'failed'],
  embedded: ['proposed', 'failed'],
  proposed: ['ingested', 'failed'],
  ingested: [],
  failed: [],
  skipped: [],
}
const TERMINAL_STAGES: ReadonlySet<PipelineStageState> = new Set(['ingested', 'failed', 'skipped'])

// #790: 转移表必须覆盖 contracts 的每个 stage — 契约新增阶段而这里漏配
// 时启动即炸（比静默漏转移好）。
if (FILE_PIPELINE_STAGES.some((s) => !(s in ALLOWED_TRANSITIONS))) {
  throw new Error('file-pipeline ALLOWED_TRANSITIONS does not cover FILE_PIPELINE_STAGES from @heurion/contracts')
}

/** #788: 所有 stage 写入走这里 — 非法转移直接抛错并落 degraded 遥测。 */
async function transitionStage(
  job: PipelineRow,
  to: PipelineStageState,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const from = job.stage as PipelineStageState
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    await recordDegraded(job.userId, job.id, job.fileId, 'transition',
      `illegal stage transition ${from} → ${to}`)
    throw new Error(`illegal file-pipeline stage transition ${from} → ${to}`)
  }
  await prisma.filePipelineJob.update({
    where: { id: job.id },
    data: { stage: to, updatedAt: new Date().toISOString(), ...extra },
  })
}

// ── Tunables (env-overridable) ─────────────────────────────────
/** Max file bytes the pipeline will read for extraction (default 20MB). */
export const PIPELINE_MAX_BYTES = parseInt(process.env.FILE_PIPELINE_MAX_BYTES || '20971520', 10)
/** #749 chunk sizing. */
export const CHUNK_CHARS = parseInt(process.env.FILE_CHUNK_CHARS || '1200', 10)
export const CHUNK_OVERLAP_CHARS = parseInt(process.env.FILE_CHUNK_OVERLAP_CHARS || '150', 10)
/**
 * Fact-extraction windows — 章节感知:markdown 标题优先断开(结构来自
 * document-extractor 的结构恢复,非启发式猜测),超长章节内部段落感知
 * 滑窗;跨章节 round-robin 轮转取窗,预算摊平到全文,长文档尾部
 * (Results/Discussion 等 fact 密度最高处)不再被 head-only 截断丢弃。
 * 每窗口 = 1 次 fast 模型调用。
 */
export const FACT_WINDOW_CHARS = parseInt(process.env.FILE_FACT_WINDOW_CHARS || '6000', 10)
export const FACT_MAX_WINDOWS = parseInt(process.env.FILE_FACT_WINDOWS || '12', 10)

type PipelineRow = Awaited<ReturnType<typeof prisma.filePipelineJob.findUniqueOrThrow>>

function uploadsBase(): string {
  // #922: 根目录唯一读取点(lib/upload-path)。注意下游是模板字符串拼接,
  // 不能换成 path.join 版 uploadsBaseDir(会归一化 '..' 等路径段,行为变化)。
  return twinsRoot()
}

function isExtractableMime(mimeType?: string | null, filename?: string | null): boolean {
  if (!mimeType && !filename) return false
  const mime = mimeType || ''
  const name = filename || ''
  // #790: text/ 前缀与扩展名清单来自 contracts（KB_EXTRACTABLE_*）；
  // office 系 mime(pptx/docx 无扩展名时)仍按子串兜底。
  const extPattern = new RegExp(`(${KB_EXTRACTABLE_EXTENSIONS.map((e) => e.replace('.', '\\.')).join('|')})$`, 'i')
  return mime.startsWith('text/')
    || extPattern.test(name)
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
    // Physical file gone (e.g. dedup cleanup race) — terminal skip (#788).
    await transitionStage(job, 'skipped', { errorMessage: 'file missing on disk' })
    return { text: null }
  }
  if (!isExtractableMime(job.mimeType, job.fileName)) {
    await transitionStage(job, 'skipped', { errorMessage: `non-extractable type ${job.mimeType}` })
    return { text: null }
  }
  if (stat.size > PIPELINE_MAX_BYTES) {
    // #749/#733: no longer silently unindexed — explicit skip + telemetry.
    await recordDegraded(job.userId, job.id, job.fileId, 'extract',
      `size ${stat.size} exceeds extract cap ${PIPELINE_MAX_BYTES}`)
    await transitionStage(job, 'skipped', { errorMessage: `file too large to index (${Math.round(stat.size / 1024)}KB)` })
    return { text: null }
  }

  const text = await extractJobText(job)
  // #788: 失败哨兵([PPTX extraction failed] / [附件 超限] 等)是终态 skip —
  // 旧代码只认 [PDF/[DOCX 两个前缀,其余哨兵文本以 stage=extracted 通过,
  // 被切 chunk 建向量索引、喂 LLM 提事实。
  if (!text.trim() || isExtractionSentinel(text)) {
    log.warn(`[PIPELINE] ${job.fileName}: no extractable text`)
    await transitionStage(job, 'skipped', { errorMessage: text.trim() ? `extraction sentinel: ${text.slice(0, 120)}` : 'no extractable text' })
    return { text: null }
  }

  await recordStage(job.userId, job.id, job.fileId, 'stage_extracted', { chars: text.length })
  await transitionStage(job, 'extracted', { extractedChars: text.length })
  return { text }
}

async function runEmbed(job: PipelineRow, ctx: ReturnType<typeof getUserContext>, text: string | null): Promise<number> {
  if (!text?.trim()) return 0

  const embedding = new EmbeddingService(job.userId, ctx.memory)
  const probe = await embedding.embedBatchOrNull(['ping'])
  if (!probe || !probe[0]) {
    // #734: degraded but observable — facts can still be proposed below.
    await recordDegraded(job.userId, job.id, job.fileId, 'embed', 'embedding provider unavailable')
    await transitionStage(job, 'embedded', { chunkCount: 0 })
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
  await transitionStage(job, 'embedded', { chunkCount: indexed })
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

  const windows = buildSectionWindows(text, FACT_WINDOW_CHARS, FACT_MAX_WINDOWS)
  const proposalIds: string[] = []
  let totalFacts = 0

  for (let w = 0; w < windows.length; w++) {
    const slice = windows[w]
    if (!slice.trim()) continue
    try {
      const prompt = factExtractionPrompt({ text: slice, mode: 'document' })
      const result = await deepseekChat(
        [{ role: 'user', content: prompt }],
        apiKey,
        {
          model: resolveTierModel('fast'),
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

  await recordStage(job.userId, job.id, job.fileId, 'stage_proposed', { totalFacts, proposals: proposalIds.length, windows: windows.length })
  await transitionStage(job, 'proposed', {
    factCount: totalFacts,
    proposalIds: JSON.stringify(proposalIds),
  })
  if (totalFacts > 0) slog.info(`[PIPELINE] ${job.fileName}: ${proposalIds.length}/${totalFacts} facts passed semantic dedup (${windows.length} section windows)`)
  return { totalFacts, proposalCount: proposalIds.length }
}

async function runIngest(job: PipelineRow): Promise<string | null> {
  if (!job.patientHash) return null
  // Synchronously pre-created by finalizeUpload (response contract keeps
  // ingestion_job_id) — here we only kick async processing.
  if (job.ingestionJobId) {
    processIngestionJob(job.ingestionJobId)
      .then((processed) => slog.info(`[PIPELINE] Ingestion job ${job.ingestionJobId} → ${processed.status}`))
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
      .then((processed) => slog.info(`[PIPELINE] Ingestion job ${ingestionJob.id} → ${processed.status}`))
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
      // #782: capture the row id up front — `job` is re-read inside the loop
      // and TS can't narrow it in the catch block.
      const jobId = job.id
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
            await transitionStage(job, 'ingested', { ingestionJobId })
            await recordStage(userId, job.id, fileId, 'stage_ingested', { ingestionJobId })
            break
          }
        }
        job = await prisma.filePipelineJob.findUnique({ where: { id: job.id } })
        if (!job) return
        // #788: skipped/failed 是终态 — 旧代码无守卫,skip 后 embed/propose
        // 空转、ingest 无条件把行覆盖成 ingested,终态语义丢失。
        if (TERMINAL_STAGES.has(job.stage as PipelineStageState)) return
      } catch (err) {
        // #733: failure is a durable state, not a console.log.
        // #782: the row id (not fileId) is the update key — `id: fileId` was a
        // P2025 every time, and the old `.catch(() => {})` swallowed it, so
        // stage=failed/errorStage never persisted and retry could never fire.
        const msg = (err as Error)?.message || String(err)
        const persisted = await prisma.filePipelineJob.update({
          where: { id: jobId },
          data: {
            stage: 'failed',
            errorStage: stageName,
            errorMessage: msg.slice(0, 400),
            updatedAt: new Date().toISOString(),
          },
        }).then(() => true).catch(() => false)
        await recordDegraded(userId, jobId, fileId, stageName,
          persisted ? msg : `${msg} (error-state persist failed)`)
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
