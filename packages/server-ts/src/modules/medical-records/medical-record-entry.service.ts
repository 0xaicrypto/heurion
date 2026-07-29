import prisma from '../../common/prisma.js'
import { createApprovalRequest } from '../approvals/approval.service.js'
import crypto from 'crypto'

function uid() { return crypto.randomBytes(8).toString('hex') }

export interface CreateMedicalRecordEntryInput {
  type: string
  title: string
  date: string
  content: string
  aiSummary?: string
  sourceFileId?: string
  sourceStudyId?: string
  sourceJobId?: string
  extractedText?: string
  rawJson?: Record<string, any>
  status?: string
  createdBy?: 'system' | 'user' | 'agent'
  linkedRecordIds?: string[]
}

export function serializeEntry(r: any) {
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

export async function createMedicalRecordEntry(
  userId: string,
  patientHash: string,
  input: CreateMedicalRecordEntryInput,
) {
  const now = new Date().toISOString()
  const status = input.status || 'confirmed'
  const createdBy = input.createdBy || 'user'

  const data = await (prisma as any).medicalRecordEntry.create({
    data: {
      id: `mre_${uid()}`,
      patientHash,
      userId,
      type: input.type,
      title: input.title,
      date: input.date,
      content: input.content,
      aiSummary: input.aiSummary,
      sourceFileId: input.sourceFileId,
      sourceStudyId: input.sourceStudyId,
      sourceJobId: input.sourceJobId,
      extractedText: input.extractedText,
      rawJson: input.rawJson ? JSON.stringify(input.rawJson) : null,
      status,
      createdBy,
      linkedRecordIds: JSON.stringify(input.linkedRecordIds || []),
      createdAt: now,
      updatedAt: now,
    },
  })

  if (status === 'pending_review') {
    await createApprovalRequest(userId, {
      targetType: 'MedicalRecordEntry',
      targetId: data.id,
      payload: serializeEntry(data),
    })
  }

  return serializeEntry(data)
}
