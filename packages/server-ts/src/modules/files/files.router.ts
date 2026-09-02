import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import prisma from '../../common/prisma'
import { getUserContext } from '../chat/user-context.js'
import { safeUploadPath } from '../../lib/upload-path.js'
import { extractDocumentText } from '../../lib/document-extractor.js'
import { verifyChartToken, issueChartToken } from '../../common/chart-token.js'
import { makeLogger } from '../../common/logger.js'
import { createExecutionPlaneService } from '../execution/execution-plane.service.js'
import {
  uploadsDir,
  chunkDir,
  UPLOAD_ID_RE,
  MAX_CHUNKS,
  CHUNK_MAX_BYTES,
  MAX_CHUNKED_TOTAL_BYTES,
  findDedup,
  finalizeUpload,
  isGeneratedFileId,
  newFileId,
  sha256Hex,
} from './files.service.js'
import { retryPipelineJob } from './file-pipeline.service.js'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export async function filesRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // ── Upload (with SHA-256 dedup) ──

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
    const sha256 = sha256Hex(buffer)
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
    const fileId = newFileId(data.filename)
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

    const fileId = newFileId(filename)
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
    const dir = uploadsDir(userId)
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
  // #745: unified pagination contract — offset/limit + independent total.
  app.get('/api/v1/files', async (request) => {
    const userId = request.user!.userId
    const dir = uploadsDir(userId)
    if (!fs.existsSync(dir)) return { files: [], total: 0, limit: 0, offset: 0 }

    const { patientHash, limit: limitRaw, offset: offsetRaw } = request.query as any
    const limit = limitRaw ? Math.max(1, parseInt(limitRaw as string, 10)) : 0
    const offset = offsetRaw ? Math.max(0, parseInt(offsetRaw as string, 10)) : 0
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

    const total = files.length
    const result = limit > 0 ? files.slice(offset, offset + limit) : files.slice(offset)
    return { files: result, total, limit, offset }
  })

  // ── Post-upload pipeline visibility (#733/#747) ──
  app.get('/api/v1/files/pipeline/jobs', async (request) => {
    const userId = request.user!.userId
    const q = request.query as any
    const limit = Math.min(200, Math.max(1, parseInt(q?.limit || '50', 10)))
    const offset = Math.max(0, parseInt(q?.offset || '0', 10))
    const where: any = { userId }
    if (q?.stage && q.stage !== 'all') where.stage = q.stage
    const [rows, total] = await Promise.all([
      prisma.filePipelineJob.findMany({ where, orderBy: { updatedAt: 'desc' }, take: limit, skip: offset }),
      prisma.filePipelineJob.count({ where }),
    ])
    return { jobs: rows, total, limit, offset }
  })

  app.post('/api/v1/files/pipeline/jobs/:jobId/retry', async (request, reply) => {
    const userId = request.user!.userId
    const { jobId } = request.params as any
    const result = await retryPipelineJob(userId, String(jobId))
    if (!result.ok) return reply.status(400).send({ error: result.error })
    return { retried: true }
  })

  // ── Chat file picker (#440; #740/#745 fixed — typed read of id, real
  //    pagination via offset/limit + total count) ──
  app.get('/api/v1/chat/files', async (request: any) => {
    const userId = request.user!.userId
    const q = request.query as any
    const limit = Math.min(500, Math.max(1, parseInt(q?.limit || '50', 10)))
    const offset = Math.max(0, parseInt(q?.offset || '0', 10))
    const patientHash = q?.patient_hash ? String(q.patient_hash) : undefined
    const where = { userId, deletedAt: null, ...(patientHash ? { patientHash } : {}) }
    const [rows, total] = await Promise.all([
      prisma.fileIndex.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
      prisma.fileIndex.count({ where }),
    ])
    return { files: rows.map((f) => ({
      file_id: f.id, name: f.name, mime_type: f.mime,
      size_bytes: f.sizeBytes, patient_hash: f.patientHash,
      created_at: f.createdAt,
    })), total, limit, offset }
  })

  // #402-followup: generated-chart library (render_chart / render_scene
  // outputs — Reactome originals + custom bioscene diagrams).
  app.get('/api/v1/files/generated', async (request) => {
    const userId = request.user!.userId
    const { listGeneratedCharts, withChartTokens } = await import('./chart-library.service.js')
    const { issueChartToken } = await import('../../common/chart-token.js')
    const entries = listGeneratedCharts(userId)
    return { charts: withChartTokens(entries, issueChartToken, userId) }
  })

  // #402-followup: delete a generated chart file.
  app.delete('/api/v1/files/generated/:fileId', async (request, reply) => {
    const userId = request.user!.userId
    const fileId = (request.params as any).fileId
    if (!isGeneratedFileId(fileId)) {
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
      await prisma.fileIndex.updateMany({
        where: { id: fileId, userId },
        data: { deletedAt: new Date().toISOString() },
      })
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
    await prisma.fileIndex.updateMany({
      where: { id: fileId, userId },
      data: { deletedAt: new Date().toISOString() },
    })
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
  // #fix 2026-09: 图片不显示的诊断日志 — 每个请求一条结论,定位失败环节:
  // token_missing/invalid_signature/expired(401) vs path_rejected/not_on_disk(404) vs ok。
  const dlog = makeLogger('files.download')
  const audit = (outcome: string, reason?: string) =>
    dlog.info(outcome === 'ok' ? 'download ok' : 'download failed', { fileId, outcome, ...(reason ? { reason } : {}) })

  // <img> render path: no Authorization header — validate the short-lived
  // chart token which also carries the file owner.
  let ownerUserId = userId ?? ''
  if (!userId) {
    if (!queryToken) {
      audit('unauthorized', 'token_missing')
      return reply.status(401).send({ error: 'Unauthorized' })
    }
    const fromToken = verifyChartToken(fileId, queryToken)
    if (!fromToken) {
      // 失效细分:过期 vs 签名不符 vs 畸形 — 重签自愈只救前两类之外的
      // 环节,签名不符通常是 CHART_TOKEN_SECRET 漂移(日志可直接定位)。
      const parts = String(queryToken).split('.')
      const exp = parts.length === 3 ? parseInt(parts[0], 36) : NaN
      const reason = parts.length !== 3 ? 'malformed' : Number.isFinite(exp) && Date.now() > exp ? 'expired' : 'invalid_signature'
      audit('unauthorized', reason)
      return reply.status(401).send({ error: 'Unauthorized' })
    }
    ownerUserId = fromToken
  }

  const filepath = safeUploadPath(ownerUserId, fileId)
  if (!filepath) {
    audit('not_found', 'path_rejected')
    return reply.status(404).send({ error: 'File not found' })
  }
  if (!fs.existsSync(filepath)) {
    audit('not_found', 'not_on_disk')
    return reply.status(404).send({ error: 'File not found' })
  }
  audit('ok', userId ? 'bearer' : 'chart_token')

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

  // #fix: Bearer-authenticated mint of a tokenized download URL — lets the
  // frontend repair legacy generate_image URLs (`/api/v1/files/<id>/download`,
  // a shape that matched no route and carried no chart token) and refresh
  // expired chart tokens for <img> without a page reload.
  app.get('/api/v1/files/:fileId/download-url', async (request, reply) => {
    const { fileId } = request.params as any
    const userId = request.user!.userId
    const filepath = safeUploadPath(userId, fileId)
    if (!filepath || !fs.existsSync(filepath)) return reply.status(404).send({ error: 'File not found' })
    const { issueChartToken } = await import('../../common/chart-token.js')
    return { file_id: fileId, url: `/api/v1/files/download/${fileId}?token=${issueChartToken(fileId, userId)}` }
  })

  // ── #771: 渲染产物 / 上传 pptx 的翻页预览（worker 端 LibreOffice 转图）──

  const PREVIEW_MAX_BYTES = 50 * 1024 * 1024
  const PREVIEW_POLL_TIMEOUT_MS = 90_000
  const PREVIEW_SUPPORTED = /\.(pptx|docx)$/i

  app.post('/api/v1/files/preview', async (request, reply) => {
    const { file_id: rawFileId } = (request.body || {}) as { file_id?: string }
    const fileId = String(rawFileId || '').trim()
    if (!fileId) return reply.status(400).send({ error: 'file_id required' })
    const userId = request.user!.userId

    const filepath = safeUploadPath(userId, fileId)
    if (!filepath || !fs.existsSync(filepath)) return reply.status(404).send({ error: 'File not found' })
    const fileName = fileId.split('_').slice(1).join('_') || fileId
    if (!PREVIEW_SUPPORTED.test(fileName)) {
      return reply.status(400).send({ error: '预览仅支持 pptx / docx 文件' })
    }
    const stat = fs.statSync(filepath)
    if (stat.size > PREVIEW_MAX_BYTES) {
      return reply.status(413).send({ error: `文件超过 ${Math.round(PREVIEW_MAX_BYTES / 1024 / 1024)}MB，无法预览` })
    }

    const plane = createExecutionPlaneService()
    const job = await plane.enqueue({
      type: 'sidecar.preview_file',
      payload: {
        data_base64: fs.readFileSync(filepath).toString('base64'),
        file_name: fileName,
        max_pages: 30,
      },
      tenant: { userId },
    })
    const deadline = Date.now() + PREVIEW_POLL_TIMEOUT_MS
    while (Date.now() < deadline) {
      const status = await plane.getStatus(job.job_id)
      if (status && status.status !== 'pending' && status.status !== 'running') {
        if (status.status !== 'completed') {
          const reason = String(status.error || (status.result as any)?.error || status.status)
          // 优雅降级：worker 未配置 LibreOffice → 明确的降级信号（前端回落仅下载）。
          if (reason.includes('PREVIEW_UNAVAILABLE')) {
            return reply.status(501).send({ error: '预览能力未配置（worker 缺少 LibreOffice），请下载后查看', degraded: true })
          }
          return reply.status(502).send({ error: `预览失败：${reason.slice(0, 200)}` })
        }
        const pages = (status.result as any)?.pages as Array<{ fileId?: string; fileName?: string; mimeType?: string }> | undefined
        if (!pages || pages.length === 0) return reply.status(502).send({ error: '预览失败：未生成任何页面' })
        return reply.send({
          page_count: pages.length,
          pages: pages.map((p, i) => ({
            index: i + 1,
            // chart token — <img> 无鉴权头也能加载（与文档内嵌图同机制）。
            url: `/api/v1/files/preview-page/${p.fileId}?token=${issueChartToken(p.fileId!, userId)}`,
          })),
        })
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    return reply.status(504).send({ error: '预览超时，请稍后重试或下载查看' })
  })

  app.get('/api/v1/files/preview-page/:fileId', async (request, reply) => {
    const fileId = (request.params as any).fileId
    const token = (request.query as any).token
    const userId = request.user?.userId || (token ? verifyChartToken(fileId, token) : null)
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' })
    const plane = createExecutionPlaneService()
    const bytes = await plane.fetchFile(fileId)
    if (!bytes || bytes.length === 0) return reply.status(404).send({ error: 'Page not found' })
    reply.header('Content-Type', 'image/png')
    reply.header('Cache-Control', 'private, max-age=3600')
    return reply.send(bytes)
  })
}
