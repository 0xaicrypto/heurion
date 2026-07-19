import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import prisma from '../../common/prisma.js'
import crypto from 'crypto'

function uid() { return crypto.randomBytes(8).toString('hex') }

interface MedicalRecordSections {
  chief_complaint?: string
  history_of_present_illness?: string
  past_medical_history?: string
  family_history?: string
  physical_exam?: string
  diagnosis?: string
  treatment_plan?: string
  progress_notes?: string
  [key: string]: string | undefined
}

export async function medicalRecordsRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // ── Create medical record ──
  app.post('/api/v1/medical-records', async (request, reply) => {
    const userId = request.user!.userId
    const { patient_hash, title, sections } = request.body as any
    if (!patient_hash) return reply.status(400).send({ error: 'patient_hash required' })

    const patient = await (prisma as any).patientRecord.findFirst({
      where: { hash: patient_hash, userId },
    })
    if (!patient) return reply.status(404).send({ error: 'Patient not found' })

    const id = `mr_${uid()}`
    const now = new Date().toISOString()
    const safeSections: MedicalRecordSections = sections && typeof sections === 'object' ? sections : {}

    await (prisma as any).medicalRecord.create({
      data: {
        id,
        patientHash: patient_hash,
        userId,
        title: title || 'Medical Record',
        sections: JSON.stringify(safeSections),
        createdAt: now,
        updatedAt: now,
      },
    })

    return {
      id,
      patient_hash: patient_hash,
      title: title || 'Medical Record',
      sections: safeSections,
      created_at: now,
      updated_at: now,
    }
  })

  // ── List medical records for a patient ──
  app.get('/api/v1/medical-records', async (request) => {
    const userId = request.user!.userId
    const { patient_hash } = request.query as any
    const where: any = { userId }
    if (patient_hash) where.patientHash = patient_hash

    const records = await (prisma as any).medicalRecord.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })

    return {
      records: records.map((r: any) => ({
        id: r.id,
        patient_hash: r.patientHash,
        title: r.title,
        sections: parseSections(r.sections),
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      })),
    }
  })

  // ── Get single medical record ──
  app.get('/api/v1/medical-records/:id', async (request, reply) => {
    const userId = request.user!.userId
    const { id } = request.params as any
    const r = await (prisma as any).medicalRecord.findFirst({ where: { id, userId } })
    if (!r) return reply.status(404).send({ error: 'Medical record not found' })

    return {
      id: r.id,
      patient_hash: r.patientHash,
      title: r.title,
      sections: parseSections(r.sections),
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    }
  })

  // ── Update medical record ──
  app.put('/api/v1/medical-records/:id', async (request, reply) => {
    const userId = request.user!.userId
    const { id } = request.params as any
    const { title, sections } = request.body as any

    const existing = await (prisma as any).medicalRecord.findFirst({ where: { id, userId } })
    if (!existing) return reply.status(404).send({ error: 'Medical record not found' })

    const data: any = { updatedAt: new Date().toISOString() }
    if (title !== undefined) data.title = title
    if (sections !== undefined) data.sections = JSON.stringify(sections)

    await (prisma as any).medicalRecord.update({ where: { id }, data })
    const r = await (prisma as any).medicalRecord.findFirst({ where: { id } })

    return {
      id: r.id,
      patient_hash: r.patientHash,
      title: r.title,
      sections: parseSections(r.sections),
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    }
  })

  // ── Delete medical record ──
  app.delete('/api/v1/medical-records/:id', async (request, reply) => {
    const userId = request.user!.userId
    const { id } = request.params as any
    const existing = await (prisma as any).medicalRecord.findFirst({ where: { id, userId } })
    if (!existing) return reply.status(404).send({ error: 'Medical record not found' })
    await (prisma as any).medicalRecord.delete({ where: { id } })
    return { deleted: true }
  })
}

function parseSections(raw: string): MedicalRecordSections {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}
