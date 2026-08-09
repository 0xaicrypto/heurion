import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import prisma from '../../common/prisma'
import { getUserContext } from '../chat/user-context.js'
import { deepseekChat, getApiKey , DEEPSEEK_CHAT_MODEL } from '../../common/llm.js'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { extractDocumentText } from '../../lib/document-extractor.js'
import { createIngestionJob, processIngestionJob } from '../ingestion/ingestion.service.js'

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
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
    const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', request.user!.userId, 'uploads')
    fs.mkdirSync(dir, { recursive: true })

    // Try dedup via FileIndex (may not exist in older DBs)
    try {
      const existing = await (prisma as any).fileIndex.findFirst({
        where: { userId: request.user!.userId, sha256 },
      })
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
    } catch {
      // FileIndex table not available — fall through to normal upload
    }

    const fileId = `${Date.now()}_${data.filename}`
    const filepath = path.join(dir, fileId)
    fs.writeFileSync(filepath, buffer)

    // Read patient_hash from form data
    const patientHash = (data.fields?.patient_hash as any)?.value || ''

    // Extract facts from text files (fire-and-forget)
    const isText = data.mimetype?.startsWith('text/') || data.filename?.endsWith('.txt') || data.filename?.endsWith('.md')
    const ctx = getUserContext(request.user!.userId)
    const docNode = ctx.memory.addDocument({
      fileId,
      sha256,
      name: data.filename,
      mimeType: data.mimetype || 'application/octet-stream',
      patientHash: patientHash || undefined,
    })
    if (isText && buffer.length < 50000) {
      const text = buffer.toString('utf-8')
      ;(async () => {
        try {
          const apiKey = getApiKey()
          const prompt = `Extract key facts from this clinical document. Return ONLY a JSON array of objects with: category (fact/preference/constraint/goal/context), importance (1-5), content (short sentence), sourceType (patient/doctor/research/general).\n\n${text.slice(0, 4000)}\n\n[JSON array]:`
          const result = await deepseekChat(
            [{ role: 'user', content: prompt }],
            apiKey,
            {
              model: DEEPSEEK_CHAT_MODEL,
              maxTokens: 2048,
              telemetryContext: {
                userId: request.user!.userId,
                workspaceId: request.user!.userId,
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
            if (added > 0) { console.log(`[FILE] Extracted ${added} facts from ${data.filename}`) }
          }
        } catch (err) { console.log('[FILE] Fact extraction skipped:', (err as Error).message.slice(0, 80)) }
      })()
    }

    // Persist file index for dedup + listing
    try {
      await (prisma as any).fileIndex.upsert({
        where: { sha256_userId: { sha256, userId: request.user!.userId } },
        update: { name: data.filename, sizeBytes: buffer.length, updatedAt: new Date().toISOString() },
        create: {
          id: fileId, userId: request.user!.userId, sha256,
          name: data.filename, mime: data.mimetype, sizeBytes: buffer.length,
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
          userId: request.user!.userId,
          fileId,
          fileName: data.filename,
          mimeType: data.mimetype || 'application/octet-stream',
          patientHash,
          uploadedBy: request.user!.userId,
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
      name: data.filename,
      mime: data.mimetype,
      size_bytes: buffer.length,
      patient_hash: patientHash || null,
      dedup: false,
      ingestion_job_id: ingestionJobId,
      ingestion_status: ingestionStatus,
    }
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

  // ── File content preview (Labs page) ──
  app.get('/api/v1/files/:fileId/content', async (request, reply) => {
    const { fileId } = request.params as any
    const userId = request.user!.userId
    const filepath = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads', fileId)

    if (!fs.existsSync(filepath)) {
      return reply.status(404).send({ error: 'File not found' })
    }

    const stat = fs.statSync(filepath)
    const name = fileId.split('_').slice(1).join('_') || fileId
    const lowerName = name.toLowerCase()
    const isDicom = lowerName.endsWith('.dcm')
    const isPdf = lowerName.endsWith('.pdf')
    const isText = lowerName.endsWith('.txt') || lowerName.endsWith('.md') || lowerName.endsWith('.csv') || fileId.includes('report') || fileId.includes('lab')

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
    const baseDir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
    let deleted = 0
    for (const rawId of ids) {
      const fileId = String(rawId)
      const filepath = path.join(baseDir, fileId)
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
    const filepath = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads', fileId)
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

  const filepath = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', ownerUserId, 'uploads', fileId)
  if (!fs.existsSync(filepath)) return reply.status(404).send({ error: 'File not found' })

  const mime = fileId.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream'
  reply.header('Content-Type', mime)
  reply.header('Cache-Control', 'public, max-age=3600')
  return reply.send(fs.createReadStream(filepath))
})

}

// Generated-chart/scene download tokens (#176/#213/#440): <img src> cannot
// send an Authorization header, so render tools issue a self-contained,
// stateless query token bound to the file AND its owner. HMAC-signed (no
// memory Map): survives server restarts; expiry is embedded in the token.
const CHART_TOKEN_SECRET = process.env.CHART_TOKEN_SECRET || process.env.SERVER_SECRET || 'dev-secret-key'
const CHART_TOKEN_TTL_MS = parseInt(process.env.CHART_TOKEN_TTL_MS || (90 * 24 * 3600 * 1000).toString(), 10)

function signChartToken(fileId: string, userId: string, exp: number): string {
  return crypto.createHmac('sha256', CHART_TOKEN_SECRET)
    .update(`${fileId}\n${exp}\n${userId}`)
    .digest('base64url')
}

export function issueChartToken(fileId: string, userId: string, ttlMs = CHART_TOKEN_TTL_MS): string {
  const exp = Date.now() + ttlMs
  return `${exp.toString(36)}.${Buffer.from(userId).toString('base64url')}.${signChartToken(fileId, userId, exp)}`
}

export function verifyChartToken(fileId: string, token: string): string | null {
  const [expB36, userIdB64, sig] = token.split('.')
  if (!expB36 || !userIdB64 || !sig) return null
  const exp = parseInt(expB36, 36)
  if (!Number.isFinite(exp) || Date.now() > exp) return null
  const userId = Buffer.from(userIdB64, 'base64url').toString()
  const expected = signChartToken(fileId, userId, exp)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return null
  if (!crypto.timingSafeEqual(a, b)) return null
  return userId
}
