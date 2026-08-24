import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import prisma from '../../common/prisma'
import { getUserContext } from '../chat/user-context.js'
import { sanitizeFilename, safeUploadPath } from '../../lib/upload-path.js'
import { deepseekChat, getApiKey , DEEPSEEK_CHAT_MODEL } from '../../common/llm.js'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { extractDocumentText } from '../../lib/document-extractor.js'
// #666: chart tokens moved to common (pure crypto) — re-exported here for
// router-level callers; the tools layer imports from common directly.
import { issueChartToken, verifyChartToken } from '../../common/chart-token.js'
export { issueChartToken, verifyChartToken }
import { createIngestionJob, processIngestionJob } from '../ingestion/ingestion.service.js'

export async function filesRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // ── Upload (with SHA-256 dedup) ──

  const uploadsDir = (userId: string) => path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')

  // #fix: 分片上传 — 大文件(>100MB 单请求上限)拆成分片逐段上传,避免
  // 单请求体积/内存峰值问题。常量:
  //   UPLOAD_ID_RE       upload_id 白名单(防路径穿越)
  //   CHUNK_MAX_BYTES    单分片上限(默认 32MB,env 可调)
  //   MAX_CHUNKS         分片总数上限(32MB×2048 = 64GB,实际由下面一条限制)
  //   MAX_CHUNKED_TOTAL_BYTES  分片总文件体积上限(默认 2GB)
  const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{8,128}$/
  const MAX_CHUNKS = 2048
  const CHUNK_MAX_BYTES = parseInt(process.env.UPLOAD_CHUNK_MAX_BYTES || '32', 10) * 1024 * 1024
  const MAX_CHUNKED_TOTAL_BYTES = parseInt(process.env.MAX_CHUNKED_UPLOAD_BYTES || '2048', 10) * 1024 * 1024
  const MAX_FACT_EXTRACT_BYTES = 500 * 1024

  const chunkDir = (userId: string, uploadId: string) => path.join(uploadsDir(userId), '.tmp', uploadId)

  async function findDedup(userId: string, sha256: string) {
    try {
      return await (prisma as any).fileIndex.findFirst({ where: { userId, sha256 } })
    } catch {
      return null
    }
  }

  interface FinalizeUploadInput {
    userId: string
    fileId: string
    filename: string
    mimeType: string
    sha256: string
    sizeBytes: number
    patientHash: string | null
  }

  /** 单次上传与分片上传共用的收尾:事实提取 + 向量索引 + 文件索引 + 摄入。 */
  async function finalizeUpload(input: FinalizeUploadInput) {
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
          const prompt = `Extract key facts from this clinical document. Return ONLY a JSON array of objects with: category (fact/preference/constraint/goal/context), importance (1-5), content (short sentence), sourceType (patient/doctor/research/general).\n\n${text.slice(0, 4000)}\n\n[JSON array]:`
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
          const jsonMatch = result.match(/\[[\s\S]*\]/)
          if (jsonMatch) {
            const facts = JSON.parse(jsonMatch[0])
            let added = 0
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

  app.post('/api/v1/files/upload', async (request, reply) => {
    // 边界审计（#253）: non-multipart requests must 400, not 500.
    let data: any
    try {
      data = await request.file()
    } catch {
      return reply.status(400).send({ error: 'Expected multipart/form-data upload' })
    }
    if (!data) return reply.status(400).send({ error: 'No file uploaded' })

    const buffer = await data.toBuffer()
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
    const dir = uploadsDir(request.user!.userId)
    fs.mkdirSync(dir, { recursive: true })

    // Try dedup via FileIndex (may not exist in older DBs)
    const existing = await findDedup(request.user!.userId, sha256)
    if (existing && !existing.deletedAt) {
      return {
        file_id: existing.id,
        name: data.filename,
        mime: data.mimetype,
        size_bytes: existing.sizeBytes,
        patient_hash: (data.fields as any)?.patient_hash?.value || existing.patientHash || null,
        dedup: true,
      }
    }

    // #553: multipart filename 可能含路径分隔 — 净化后再入库。
    const fileId = `${Date.now()}_${sanitizeFilename(data.filename)}`
    const filepath = path.join(dir, fileId)
    fs.writeFileSync(filepath, buffer)

    // Read patient_hash from form data
    const patientHash = (data.fields?.patient_hash as any)?.value || ''

    return finalizeUpload({
      userId: request.user!.userId,
      fileId,
      filename: data.filename,
      mimeType: data.mimetype || 'application/octet-stream',
      sha256,
      sizeBytes: buffer.length,
      patientHash: patientHash || null,
    })
  })

  // ── 分片上传:upload-chunk / upload-complete / upload-abort ──
  // 客户端把大文件切成 ≤CHUNK_MAX_BYTES 的分片逐段 POST,完成后一次性
  // 合并 + 去重 + 收尾。失败可 upload-abort 清理;崩溃残留的 .tmp 目录
  // 不会进入文件列表(见下方 isDirectory 过滤)。
  app.post('/api/v1/files/upload-chunk', async (request, reply) => {
    let data: any
    try {
      data = await request.file({ limits: { fileSize: CHUNK_MAX_BYTES } })
    } catch (err: any) {
      if (err?.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.status(413).send({ error: `单分片超过 ${Math.round(CHUNK_MAX_BYTES / 1024 / 1024)}MB 上限` })
      }
      return reply.status(400).send({ error: 'Expected multipart/form-data upload' })
    }
    if (!data) return reply.status(400).send({ error: 'No file uploaded' })

    const uploadId = String(data.fields?.upload_id?.value || '')
    const index = parseInt(String(data.fields?.index?.value || ''), 10)
    const total = parseInt(String(data.fields?.total?.value || ''), 10)
    if (!UPLOAD_ID_RE.test(uploadId)) {
      return reply.status(400).send({ error: 'Invalid upload_id' })
    }
    if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1 || total > MAX_CHUNKS) {
      return reply.status(400).send({ error: `index/total must be integers in [1, ${MAX_CHUNKS}]` })
    }

    const buffer = await data.toBuffer()
    const dir = chunkDir(request.user!.userId, uploadId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `chunk_${String(index).padStart(6, '0')}`), buffer)
    return { received: index, total }
  })

  app.post('/api/v1/files/upload-complete', async (request, reply) => {
    const body = (request.body || {}) as any
    const uploadId = String(body.upload_id || '')
    const filename = String(body.filename || '')
    const total = parseInt(String(body.total || ''), 10)
    const patientHash = String(body.patient_hash || '') || null
    const mimeType = String(body.mime || '') || 'application/octet-stream'
    if (!UPLOAD_ID_RE.test(uploadId)) return reply.status(400).send({ error: 'Invalid upload_id' })
    if (!Number.isInteger(total) || total < 1 || total > MAX_CHUNKS) {
      return reply.status(400).send({ error: `total must be an integer in [1, ${MAX_CHUNKS}]` })
    }
    if (!filename.trim()) return reply.status(400).send({ error: 'filename is required' })

    const dir = chunkDir(request.user!.userId, uploadId)
    if (!fs.existsSync(dir)) return reply.status(400).send({ error: 'Upload session not found — upload chunks first' })
    for (let i = 1; i <= total; i++) {
      const chunkPath = path.join(dir, `chunk_${String(i).padStart(6, '0')}`)
      if (!fs.existsSync(chunkPath)) {
        return reply.status(400).send({ error: `Missing chunk ${i}/${total}` })
      }
    }

    // 顺序合并 + 流式 sha256(分片单独落盘,不整读进内存)。
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
      return reply.status(413).send({ error: `分片总大小超过 ${Math.round(MAX_CHUNKED_TOTAL_BYTES / 1024 / 1024)}MB 上限` })
    }

    // 合并后去重(与单次上传同口径)。
    const existing = await findDedup(request.user!.userId, sha256)
    if (existing && !existing.deletedAt) {
      fs.rmSync(dir, { recursive: true, force: true })
      return {
        file_id: existing.id,
        name: filename,
        mime: mimeType,
        size_bytes: existing.sizeBytes,
        patient_hash: patientHash || existing.patientHash || null,
        dedup: true,
      }
    }

    const fileId = `${Date.now()}_${sanitizeFilename(filename)}`
    fs.renameSync(tmpMerged, path.join(uploadsDir(request.user!.userId), fileId))
    fs.rmSync(dir, { recursive: true, force: true })

    return finalizeUpload({
      userId: request.user!.userId,
      fileId,
      filename,
      mimeType,
      sha256,
      sizeBytes,
      patientHash,
    })
  })

  app.post('/api/v1/files/upload-abort', async (request, reply) => {
    const uploadId = String((request.body as any)?.upload_id || '')
    if (!UPLOAD_ID_RE.test(uploadId)) return reply.status(400).send({ error: 'Invalid upload_id' })
    fs.rmSync(chunkDir(request.user!.userId, uploadId), { recursive: true, force: true })
    return { aborted: true }
  })

  // ── Uploads list (imaging page) ──
  app.get('/api/v1/files/uploads', async (request) => {
    const userId = request.user!.userId
    const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
    if (!fs.existsSync(dir)) return []

    const { patient_hash, limit } = request.query as any
    const files = fs.readdirSync(dir)
      .map(f => {
        const stat = fs.statSync(path.join(dir, f))
        // #fix: .tmp 分片临时目录不进入文件列表(目录按缺失处理)。
        if (stat.isDirectory()) return null
        return {
          file_id: f,
          name: f.split('_').slice(1).join('_') || f,
          mime: f.endsWith('.dcm') ? 'application/dicom' : f.endsWith('.txt') ? 'text/plain' : 'application/octet-stream',
          size_bytes: stat.size,
          created_at: stat.birthtime.toISOString(),
          patient_hash: patient_hash || null,
          dicom_status: f.endsWith('.dcm') ? 'indexed' : 'none',
          dicom_study_id: f.endsWith('.dcm') ? f.replace('.dcm', '') : null,
        }
      })
      .filter((x): x is { file_id: string; name: string; mime: string; size_bytes: number; created_at: string; patient_hash: string | null; dicom_status: string; dicom_study_id: string | null } => x !== null)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    return limit ? files.slice(0, parseInt(limit as string)) : files
  })

  // ── List all files ──
  app.get('/api/v1/files', async (request) => {
    const userId = request.user!.userId
    const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
    if (!fs.existsSync(dir)) return { files: [], total: 0 }

    const { patientHash, limit } = request.query as any
    const files = fs.readdirSync(dir)
      .map(f => {
        const stat = fs.statSync(path.join(dir, f))
        // #fix: .tmp 分片临时目录不进入文件列表。
        if (stat.isDirectory()) return null
        const parts = f.split('_')
        return {
          file_id: f,
          name: parts.slice(1).join('_') || f,
          mime: f.endsWith('.dcm') ? 'application/dicom' : f.endsWith('.txt') ? 'text/plain' : f.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
          size_bytes: stat.size,
          patient_hash: patientHash || null,
          created_at: stat.birthtime.toISOString(),
        }
      })
      .filter((x): x is { file_id: string; name: string; mime: string; size_bytes: number; patient_hash: string | null; created_at: string } => x !== null)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    const result = limit ? files.slice(0, parseInt(limit as string)) : files
    return { files: result, total: result.length }
  })

  // ── Chat file picker (#440, moved from stubs.router) ──
  app.get('/api/v1/chat/files', async (request: any) => {
    const userId = request.user!.userId
    const files = await (prisma as any).fileIndex.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }).catch(() => [])
    return { files: files.map((f: any) => ({
      file_id: f.fileId, name: f.name, mime_type: f.mimeType,
      size_bytes: f.sizeBytes, patient_hash: f.patientHash,
      created_at: f.createdAt,
    })) }
  })

  // #402-followup: generated-chart library (render_chart / render_scene
  // outputs — Reactome originals + custom bioscene diagrams).
  app.get('/api/v1/files/generated', async (request) => {
    const userId = request.user!.userId
    const { listGeneratedCharts, withChartTokens } = await import('../chat/chart-library.service.js')
    const entries = listGeneratedCharts(userId)
    return { charts: withChartTokens(entries, issueChartToken, userId) }
  })

  // #402-followup: delete a generated chart file.
  app.delete('/api/v1/files/generated/:fileId', async (request, reply) => {
    const userId = request.user!.userId
    const fileId = (request.params as any).fileId
    if (!fileId.startsWith('scene_') && !fileId.startsWith('chart_')) {
      return reply.status(400).send({ error: 'not a generated chart' })
    }
    const filepath = safeUploadPath(userId, fileId)
    if (!filepath || !fs.existsSync(filepath)) return reply.status(404).send({ error: 'File not found' })
    fs.unlinkSync(filepath)
    try {
      const ctx = getUserContext(userId)
      ctx.memory.deleteDocument(fileId)
    } catch { /* best-effort */ }
    return { deleted: true }
  })

  // ── File content preview (Labs page) ──
  app.get('/api/v1/files/:fileId/content', async (request, reply) => {
    const { fileId } = request.params as any
    const userId = request.user!.userId
    const filepath = safeUploadPath(userId, fileId)

    if (!filepath || !fs.existsSync(filepath)) {
      return reply.status(404).send({ error: 'File not found' })
    }

    const stat = fs.statSync(filepath)
    const name = fileId.split('_').slice(1).join('_') || fileId
    const lowerName = name.toLowerCase()
    const isDicom = lowerName.endsWith('.dcm')
    const isPdf = lowerName.endsWith('.pdf')
    const isText = lowerName.endsWith('.txt') || lowerName.endsWith('.md') || lowerName.endsWith('.csv') || lowerName.endsWith('.docx') || fileId.includes('report') || fileId.includes('lab')

    if (isDicom) {
      const { quickScanDicom } = await import('../patients/dicom-scanner.js')
      const findings = quickScanDicom(userId, fileId)
      return {
        file_id: fileId,
        type: 'dicom',
        size_bytes: stat.size,
        findings: findings.filter((f: any) => f.type !== 'meta' && f.type !== 'error'),
      }
    }

    if (isPdf || isText) {
      const buffer = fs.readFileSync(filepath)
      const text = await extractDocumentText(buffer, name, undefined, { maxChars: 10000 })
      return {
        file_id: fileId,
        type: isPdf ? 'pdf' : 'text',
        size_bytes: stat.size,
        content: text,
      }
    }

    return {
      file_id: fileId,
      type: 'binary',
      size_bytes: stat.size,
      content: `Binary file (${stat.size} bytes)`,
    }
  })
  app.delete('/api/v1/files/bulk', async (request) => {
    const userId = request.user!.userId
    const ids = (request.body as any)?.ids
    if (!Array.isArray(ids)) return { deleted: 0 }
    const ctx = getUserContext(userId)
    let deleted = 0
    for (const rawId of ids) {
      const fileId = String(rawId)
      const filepath = safeUploadPath(userId, fileId)
      if (!filepath) continue
      try {
        await (prisma as any).fileIndex.updateMany({
          where: { id: fileId, userId },
          data: { deletedAt: new Date().toISOString() },
        })
      } catch { /* FileIndex may not exist */ }
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath)
        ctx.memory.deleteDocument(fileId)
        deleted++
      }
    }
    return { deleted }
  })

  app.delete('/api/v1/files/:fileId', async (request, reply) => {
    const { fileId } = request.params as any
    const userId = request.user!.userId
    const ctx = getUserContext(userId)
    const filepath = safeUploadPath(userId, fileId)
    if (!filepath) return reply.status(404).send({ error: 'File not found' })
    // Soft-delete in FileIndex
    try {
      await (prisma as any).fileIndex.updateMany({
        where: { id: fileId, userId },
        data: { deletedAt: new Date().toISOString() },
      })
    } catch { /* FileIndex may not exist */ }
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath)
      ctx.memory.deleteDocument(fileId)
      return { deleted: true }
    }
    return reply.status(404).send({ error: 'File not found' })
  })
app.get('/api/v1/files/download/:fileId', async (request, reply) => {
  const fileId = (request.params as any).fileId
  const userId = request.user?.userId
  const queryToken = (request.query as any).token

  // <img> render path: no Authorization header — validate the short-lived
  // chart token which also carries the file owner.
  let ownerUserId = userId ?? ''
  if (!userId) {
    const fromToken = queryToken ? verifyChartToken(fileId, queryToken) : null
    if (!fromToken) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
    ownerUserId = fromToken
  }

  const filepath = safeUploadPath(ownerUserId, fileId)
  if (!filepath || !fs.existsSync(filepath)) return reply.status(404).send({ error: 'File not found' })

  // #fix: 文档内嵌图(img_* 落盘文件)按扩展名给 MIME — 之前只有 svg,
  // 其余全当 octet-stream,<img> 在部分浏览器拒绝渲染。
  const ext = fileId.split('.').pop()?.toLowerCase() || ''
  const mimeByExt: Record<string, string> = {
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', pdf: 'application/pdf',
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  }
  const mime = mimeByExt[ext] || 'application/octet-stream'
  reply.header('Content-Type', mime)
  reply.header('Cache-Control', 'public, max-age=3600')

  // #opt: large generated SVGs (Reactome diagrams ~1.3MB) are served gzipped
  // — browsers decompress transparently for <img>, cutting transfer ~4x.
  const stat = fs.statSync(filepath)
  if (mime === 'image/svg+xml' && stat.size > 100 * 1024) {
    const accept = String(request.headers['accept-encoding'] || '')
    if (accept.includes('gzip')) {
      const body = fs.readFileSync(filepath)
      const zlib = await import('zlib')
      const gz = zlib.gzipSync(body, { level: 9 })
      if (gz.length < body.length) {
        reply.header('Content-Encoding', 'gzip')
        reply.header('Content-Length', String(gz.length))
        return reply.send(gz)
      }
    }
  }
  return reply.send(fs.createReadStream(filepath))
})
}
