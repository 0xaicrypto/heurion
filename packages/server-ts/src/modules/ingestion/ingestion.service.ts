import prisma from '../../common/prisma.js'
import { createMedicalRecordEntry } from '../medical-records/medical-record-entry.service.js'
import { extractDocumentText } from '../../lib/document-extractor.js'
import { analyzerRegistry, registerAnalyzer } from './analyzer-registry.js'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

function uid() { return crypto.randomBytes(8).toString('hex') }

export { analyzerRegistry, registerAnalyzer }

export interface MedicalRecordEntryDraft {
  type: string
  title: string
  date: string
  content: string
  aiSummary?: string
  status?: string
  createdBy?: 'system' | 'user' | 'agent'
  extractedText?: string
  rawJson?: Record<string, any>
}

export interface IngestionResult {
  confidence: 'high' | 'medium' | 'low'
  reasoning: string
  entries: MedicalRecordEntryDraft[]
  errors?: string[]
}

export interface IngestionJob {
  id: string
  userId: string
  fileId: string
  fileName: string
  mimeType: string
  patientHash?: string
  studyId?: string
  uploadedBy: string
  extractedText?: string
  extractedJson?: any
  status: string
  confidence?: string
  reasoning?: string
  resultPayload?: any
  retryCount: number
  failedReason?: string
  createdAt: string
  updatedAt: string
}

export interface IngestionAnalyzer {
  name: string
  analyze(job: IngestionJob): Promise<IngestionResult>
}

// Default note analyzer: creates a single raw note entry from extracted text.
analyzerRegistry['text/plain'] = {
  name: 'note',
  async analyze(job) {
    return {
      confidence: 'medium',
      reasoning: 'Plain text note extracted from file.',
      entries: [
        {
          type: 'note',
          title: job.fileName || 'Note',
          date: new Date().toISOString(),
          content: job.extractedText?.slice(0, 2000) || 'No text extracted',
          status: 'pending_review',
          createdBy: 'system',
          extractedText: job.extractedText,
        },
      ],
    }
  },
}

export interface CreateIngestionJobInput {
  userId: string
  fileId: string
  fileName: string
  mimeType: string
  patientHash?: string
  studyId?: string
  uploadedBy: string
  extractedText?: string
}

export async function createIngestionJob(input: CreateIngestionJobInput) {
  const now = new Date().toISOString()
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const existing = await (prisma as any).ingestionJob.findFirst({
    where: {
      userId: input.userId,
      fileId: input.fileId,
      patientHash: input.patientHash || null,
      studyId: input.studyId || null,
      createdAt: { gte: oneDayAgo },
    },
    orderBy: { createdAt: 'desc' },
  })
  if (existing) return serializeJob(existing)

  const job = await (prisma as any).ingestionJob.create({
    data: {
      id: `ing_${uid()}`,
      userId: input.userId,
      fileId: input.fileId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      patientHash: input.patientHash,
      studyId: input.studyId,
      uploadedBy: input.uploadedBy,
      extractedText: input.extractedText,
      status: 'pending',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    },
  })
  return serializeJob(job)
}

export async function getIngestionJob(id: string) {
  const job = await (prisma as any).ingestionJob.findUnique({ where: { id } })
  return job ? serializeJob(job) : null
}

export async function processIngestionJob(id: string) {
  let job = await (prisma as any).ingestionJob.findUnique({ where: { id } })
  if (!job) throw new Error('Job not found')
  if (job.status !== 'pending') return serializeJob(job)

  const now = () => new Date().toISOString()

  // Extraction step
  await updateJobStatus(job.id, 'extracting')
  if (!job.extractedText) {
    try {
      const extracted = await extractTextForJob(job)
      await (prisma as any).ingestionJob.update({
        where: { id: job.id },
        data: {
          extractedText: extracted.text,
          extractedJson: extracted.json ? JSON.stringify(extracted.json) : null,
          updatedAt: now(),
        },
      })
    } catch (err: any) {
      return await failJob(job.id, `extraction failed: ${err.message}`)
    }
  }

  // Analysis step with retries
  await updateJobStatus(job.id, 'analyzing')
  const analyzer = analyzerRegistry[job.mimeType]
  if (!analyzer) {
    return await failJob(job.id, `no analyzer registered for ${job.mimeType}`)
  }

  let result: IngestionResult | null = null
  let lastError: Error | null = null
  const maxRetries = 3
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const fresh = await (prisma as any).ingestionJob.findUnique({ where: { id: job.id } })
      result = await analyzer.analyze(serializeJob(fresh))
      break
    } catch (err: any) {
      lastError = err
      await (prisma as any).ingestionJob.update({
        where: { id: job.id },
        data: { retryCount: attempt + 1, updatedAt: now() },
      })
    }
  }

  if (!result) {
    return await failJob(job.id, `analysis failed after ${maxRetries} attempts: ${lastError?.message}`)
  }

  // Create entries and approval requests
  const fresh = await (prisma as any).ingestionJob.findUnique({ where: { id: job.id } })
  const entries: any[] = []
  for (const draft of result.entries) {
    if (!fresh.patientHash) continue
    const entry = await createMedicalRecordEntry(fresh.userId, fresh.patientHash, {
      ...draft,
      status: draft.status || 'pending_review',
      createdBy: draft.createdBy || 'system',
      sourceJobId: fresh.id,
    })
    entries.push(entry)
  }

  const completed = await (prisma as any).ingestionJob.update({
    where: { id: job.id },
    data: {
      status: 'awaiting_review',
      confidence: result.confidence,
      reasoning: result.reasoning,
      resultPayload: JSON.stringify({ entries }),
      updatedAt: now(),
    },
  })
  return serializeJob(completed)
}

async function updateJobStatus(id: string, status: string) {
  await (prisma as any).ingestionJob.update({
    where: { id },
    data: { status, updatedAt: new Date().toISOString() },
  })
}

async function failJob(id: string, reason: string) {
  const job = await (prisma as any).ingestionJob.update({
    where: { id },
    data: { status: 'failed', failedReason: reason, updatedAt: new Date().toISOString() },
  })
  return serializeJob(job)
}

async function extractTextForJob(job: any): Promise<{ text: string; json?: any }> {
  if (job.mimeType === 'text/plain') {
    // For plain text we expect the file content to be stored; fallback to empty.
    return { text: '' }
  }

  // Try to locate the uploaded file on disk. This is a best-effort default.
  const uploadDir = process.env.UPLOAD_DIR || './uploads'
  const filePath = path.join(uploadDir, job.userId, job.fileId)

  if (job.mimeType === 'application/dicom') {
    return extractDicomSummary(filePath)
  }

  if (job.mimeType?.startsWith('image/')) {
    // Images are analyzed by vision models; no text extraction needed here.
    return { text: '' }
  }

  if (fs.existsSync(filePath)) {
    const buffer = fs.readFileSync(filePath)
    const text = await extractDocumentText(buffer, job.fileName)
    return { text }
  }

  return { text: '' }
}

function extractDicomSummary(filePath: string): { text: string; json?: any } {
  if (!fs.existsSync(filePath)) return { text: '' }

  let dicomParser: any = null
  try {
    dicomParser = require('dicom-parser')
  } catch {
    return { text: '[DICOM parser unavailable]' }
  }

  try {
    const buffer = fs.readFileSync(filePath)
    const arr = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    const dataSet = dicomParser.parseDicom(new Uint8Array(arr))

    const s = (tag: string) => { try { return dataSet.string(tag) } catch { return undefined } }
    const meta = {
      patientName: s('x00100010'),
      patientId: s('x00100020'),
      sex: s('x00100040'),
      age: s('x00101010'),
      studyDescription: s('x00081030'),
      studyDate: s('x00080020'),
      modality: s('x00080060'),
      institution: s('x00080080'),
      manufacturer: s('x00080070'),
      model: s('x00081090'),
      rows: dataSet.uint16('x00280010') || undefined,
      cols: dataSet.uint16('x00280011') || undefined,
      sliceThickness: s('x00180050'),
    }

    const parts: string[] = []
    if (meta.studyDescription) parts.push(meta.studyDescription)
    if (meta.modality) parts.push(meta.modality)
    if (meta.studyDate) parts.push(meta.studyDate)
    if (meta.rows && meta.cols) parts.push(`${meta.rows}x${meta.cols}`)

    return {
      text: parts.join(' | ') || 'DICOM file',
      json: { dicom: meta },
    }
  } catch (err: any) {
    return { text: `[DICOM parse failed: ${err.message}]` }
  }
}

function serializeJob(r: any): IngestionJob {
  return {
    id: r.id,
    userId: r.userId,
    fileId: r.fileId,
    fileName: r.fileName,
    mimeType: r.mimeType,
    patientHash: r.patientHash,
    studyId: r.studyId,
    uploadedBy: r.uploadedBy,
    extractedText: r.extractedText,
    extractedJson: r.extractedJson ? JSON.parse(r.extractedJson) : undefined,
    status: r.status,
    confidence: r.confidence,
    reasoning: r.reasoning,
    resultPayload: r.resultPayload ? JSON.parse(r.resultPayload) : undefined,
    retryCount: r.retryCount,
    failedReason: r.failedReason,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

export { serializeJob }
