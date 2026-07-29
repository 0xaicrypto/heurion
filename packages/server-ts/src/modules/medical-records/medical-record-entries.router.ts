import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authGuard } from '../../common/auth.guard.js'
import prisma from '../../common/prisma.js'
import crypto from 'crypto'

function uid() { return crypto.randomBytes(8).toString('hex') }

const entryTypeEnum = z.enum([
  'lab',
  'imaging',
  'pathology',
  'ecg',
  'note',
  'diagnosis',
  'medication',
  'procedure',
  'vaccination',
  'allergy',
])

const statusEnum = z.enum(['pending_review', 'confirmed', 'rejected'])

const createSchema = z.object({
  type: entryTypeEnum,
  title: z.string().min(1),
  date: z.string().default(() => new Date().toISOString()),
  content: z.string().min(1),
  aiSummary: z.string().optional(),
  sourceFileId: z.string().optional(),
  sourceStudyId: z.string().optional(),
  sourceJobId: z.string().optional(),
  extractedText: z.string().optional(),
  rawJson: z.record(z.any()).optional(),
  status: statusEnum.default('confirmed'),
  createdBy: z.enum(['system', 'user', 'agent']).default('user'),
  linkedRecordIds: z.array(z.string()).default([]),
})

const patchSchema = z.object({
  type: entryTypeEnum.optional(),
  title: z.string().min(1).optional(),
  date: z.string().optional(),
  content: z.string().min(1).optional(),
  aiSummary: z.string().optional(),
  extractedText: z.string().optional(),
  rawJson: z.record(z.any()).optional(),
  status: statusEnum.optional(),
  rejectedReason: z.string().optional(),
  linkedRecordIds: z.array(z.string()).optional(),
}).refine((data) => {
  if (data.status === 'rejected' && !data.rejectedReason) return false
  return true
}, { message: 'rejectedReason required when status is rejected', path: ['rejectedReason'] })

function serializeEntry(r: any) {
  return {
    id: r.id,
    patientHash: r.patientHash,
    type: r.type,
    title: r.title,
    date: r.date,
    content: r.content,
    aiSummary: r.aiSummary,
    sourceFileId: r.sourceFileId,
    sourceStudyId: r.sourceStudyId,
    sourceJobId: r.sourceJobId,
    extractedText: r.extractedText,
    rawJson: r.rawJson ? JSON.parse(r.rawJson) : null,
    status: r.status,
    createdBy: r.createdBy,
    confirmedAt: r.confirmedAt,
    confirmedBy: r.confirmedBy,
    rejectedReason: r.rejectedReason,
    version: r.version,
    previousVersionId: r.previousVersionId,
    linkedRecordIds: JSON.parse(r.linkedRecordIds || '[]'),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

export async function medicalRecordEntriesRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // Create entry
  app.post('/api/v1/patients/:hash/medical-records', async (request, reply) => {
    const userId = request.user!.userId
    const { hash } = request.params as any
    const body = createSchema.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: body.error.format() })
    }

    const patient = await (prisma as any).patientRecord.findFirst({
      where: { hash, userId },
    })
    if (!patient) return reply.status(404).send({ error: 'Patient not found' })

    const now = new Date().toISOString()
    const data = await (prisma as any).medicalRecordEntry.create({
      data: {
        id: `mre_${uid()}`,
        patientHash: hash,
        userId,
        ...body.data,
        rawJson: body.data.rawJson ? JSON.stringify(body.data.rawJson) : null,
        linkedRecordIds: JSON.stringify(body.data.linkedRecordIds),
        createdAt: now,
        updatedAt: now,
      },
    })

    return serializeEntry(data)
  })

  // List entries
  app.get('/api/v1/patients/:hash/medical-records', async (request, reply) => {
    const userId = request.user!.userId
    const { hash } = request.params as any
    const { type, status } = request.query as any

    const patient = await (prisma as any).patientRecord.findFirst({
      where: { hash, userId },
    })
    if (!patient) return reply.status(404).send({ error: 'Patient not found' })

    const where: any = { patientHash: hash, userId }
    if (type) where.type = type
    if (status) where.status = status

    const records = await (prisma as any).medicalRecordEntry.findMany({
      where,
      orderBy: { date: 'desc' },
    })

    return { records: records.map(serializeEntry) }
  })

  // Get single
  app.get('/api/v1/patients/:hash/medical-records/:id', async (request, reply) => {
    const userId = request.user!.userId
    const { hash, id } = request.params as any

    const r = await (prisma as any).medicalRecordEntry.findFirst({
      where: { id, patientHash: hash, userId },
    })
    if (!r) return reply.status(404).send({ error: 'Entry not found' })

    return serializeEntry(r)
  })

  // Update (versioned)
  app.patch('/api/v1/patients/:hash/medical-records/:id', async (request, reply) => {
    const userId = request.user!.userId
    const { hash, id } = request.params as any
    const parsed = patchSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.format() })
    }

    const existing = await (prisma as any).medicalRecordEntry.findFirst({
      where: { id, patientHash: hash, userId },
    })
    if (!existing) return reply.status(404).send({ error: 'Entry not found' })

    const updates = parsed.data
    const now = new Date().toISOString()
    const isStatusChange = updates.status && updates.status !== existing.status

    let confirmedAt = existing.confirmedAt
    let confirmedBy = existing.confirmedBy
    if (updates.status === 'confirmed' && existing.status !== 'confirmed') {
      confirmedAt = now
      confirmedBy = userId
    }

    const rawJson = updates.rawJson !== undefined
      ? JSON.stringify(updates.rawJson)
      : existing.rawJson
    const linkedRecordIds = updates.linkedRecordIds !== undefined
      ? JSON.stringify(updates.linkedRecordIds)
      : existing.linkedRecordIds

    // Versioned update: create a new record pointing back to the previous one.
    const next = await (prisma as any).medicalRecordEntry.create({
      data: {
        id: `mre_${uid()}`,
        patientHash: existing.patientHash,
        userId,
        type: updates.type ?? existing.type,
        title: updates.title ?? existing.title,
        date: updates.date ?? existing.date,
        content: updates.content ?? existing.content,
        aiSummary: updates.aiSummary !== undefined ? updates.aiSummary : existing.aiSummary,
        sourceFileId: existing.sourceFileId,
        sourceStudyId: existing.sourceStudyId,
        sourceJobId: existing.sourceJobId,
        extractedText: updates.extractedText !== undefined ? updates.extractedText : existing.extractedText,
        rawJson,
        status: updates.status ?? existing.status,
        createdBy: existing.createdBy,
        confirmedAt,
        confirmedBy,
        rejectedReason: updates.rejectedReason !== undefined ? updates.rejectedReason : existing.rejectedReason,
        version: existing.version + 1,
        previousVersionId: existing.id,
        linkedRecordIds,
        createdAt: existing.createdAt,
        updatedAt: now,
      },
    })

    return serializeEntry(next)
  })

  // Delete
  app.delete('/api/v1/patients/:hash/medical-records/:id', async (request, reply) => {
    const userId = request.user!.userId
    const { hash, id } = request.params as any

    const existing = await (prisma as any).medicalRecordEntry.findFirst({
      where: { id, patientHash: hash, userId },
    })
    if (!existing) return reply.status(404).send({ error: 'Entry not found' })

    await (prisma as any).medicalRecordEntry.delete({ where: { id } })
    return { deleted: true }
  })
}
