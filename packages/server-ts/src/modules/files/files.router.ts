import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import prisma from '../../common/prisma'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export async function filesRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // ── Upload (with SHA-256 dedup) ──
  app.post('/api/v1/files/upload', async (request, reply) => {
    const data = await request.file()
    if (!data) return reply.status(400).send({ error: 'No file uploaded' })

    const buffer = await data.toBuffer()
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
    const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', request.user!.userId, 'uploads')
    fs.mkdirSync(dir, { recursive: true })

    // Check for existing file with same hash (dedup)
    const existing = await (prisma as any).fileIndex.findFirst({
      where: { userId: request.user!.userId, sha256 },
    })
    if (existing && !existing.deletedAt) {
      return {
        file_id: existing.id,
        name: data.filename,
        mime: data.mimetype,
        size_bytes: existing.sizeBytes,
        patient_hash: data.fields?.patient_hash?.value || existing.patientHash || null,
        dedup: true,
      }
    }

    const fileId = `${Date.now()}_${data.filename}`
    const filepath = path.join(dir, fileId)
    fs.writeFileSync(filepath, buffer)

    // Read patient_hash from form data
    const patientHash = (data.fields?.patient_hash as any)?.value || ''

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

    return {
      file_id: fileId,
      name: data.filename,
      mime: data.mimetype,
      size_bytes: buffer.length,
      patient_hash: patientHash || null,
      dedup: false,
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
    if (!fs.existsSync(dir)) return []

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

  // ── File content preview (Labs page) ──
  app.get('/api/v1/files/:fileId/content', async (request, reply) => {
    const { fileId } = request.params as any
    const userId = request.user!.userId
    const filepath = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads', fileId)

    if (!fs.existsSync(filepath)) {
      return reply.status(404).send({ error: 'File not found' })
    }

    const stat = fs.statSync(filepath)
    const isText = fileId.endsWith('.txt') || fileId.includes('report') || fileId.includes('lab')
    const isDicom = fileId.endsWith('.dcm')

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

    if (isText) {
      const text = fs.readFileSync(filepath, 'utf-8').slice(0, 10000)
      return {
        file_id: fileId,
        type: 'text',
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
  app.delete('/api/v1/files/:fileId', async (request, reply) => {
    const { fileId } = request.params as any
    const filepath = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', request.user!.userId, 'uploads', fileId)
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath)
      return { deleted: true }
    }
    return reply.status(404).send({ error: 'File not found' })
  })
}
