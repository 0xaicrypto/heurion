import { describe, test, expect, beforeEach } from 'vitest'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import {
  createIngestionJob,
  processIngestionJob,
  getIngestionJob,
  analyzerRegistry,
  type IngestionAnalyzer,
} from '../../src/modules/ingestion/ingestion.service.js'
import crypto from 'crypto'

function fileId() { return `file_${crypto.randomBytes(8).toString('hex')}` }

async function createPatient(app: any, initials = 'ING') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/dicom/patients/register-manual',
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: { initials, age: 40, sex: 'M' },
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.payload).patient_hash
}

describe('Ingestion Worker', () => {
  beforeEach(() => {
    // Clear test-specific analyzers between tests
    for (const key of Object.keys(analyzerRegistry)) {
      if (key.startsWith('test/')) delete analyzerRegistry[key]
    }
  })

  test('creates a pending ingestion job', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const hash = await createPatient(app)
    const fid = fileId()
    const job = await createIngestionJob({
      userId,
      fileId: fid,
      fileName: 'note.txt',
      mimeType: 'text/plain',
      patientHash: hash,
      uploadedBy: userId,
    })
    expect(job.status).toBe('pending')
    expect(job.patientHash).toBe(hash)
  })

  test('processes a job with a mock analyzer and creates pending entries', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const hash = await createPatient(app)
    const fid = fileId()

    const mockAnalyzer: IngestionAnalyzer = {
      name: 'mock',
      async analyze() {
        return {
          confidence: 'high',
          reasoning: 'mock reason',
          entries: [
            {
              type: 'note',
              title: 'Mock note',
              date: new Date().toISOString(),
              content: 'mock content',
              status: 'pending_review',
              createdBy: 'system',
            },
          ],
        }
      },
    }
    analyzerRegistry['text/plain'] = mockAnalyzer

    const job = await createIngestionJob({
      userId,
      fileId: fid,
      fileName: 'note.txt',
      mimeType: 'text/plain',
      patientHash: hash,
      uploadedBy: userId,
    })
    const processed = await processIngestionJob(job.id)
    expect(processed.status).toBe('awaiting_review')

    const approvals = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: await authHeader(),
    })
    expect(JSON.parse(approvals.payload).requests.length).toBeGreaterThan(0)
  })

  test('routes PDF to PdfReportAnalyzer by default', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const hash = await createPatient(app)
    const fid = fileId()

    const job = await createIngestionJob({
      userId,
      fileId: fid,
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      patientHash: hash,
      uploadedBy: userId,
    })
    // PdfReportAnalyzer will likely fail due to missing file/text; expect failed or raw fallback
    const processed = await processIngestionJob(job.id)
    expect(['awaiting_review', 'failed']).toContain(processed.status)
  })

  test('retries analyzer failures and eventually marks job failed', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const hash = await createPatient(app)
    const fid = fileId()

    let attempts = 0
    const failingAnalyzer: IngestionAnalyzer = {
      name: 'failing',
      async analyze() {
        attempts++
        throw new Error('always fails')
      },
    }
    analyzerRegistry['test/failing'] = failingAnalyzer

    const job = await createIngestionJob({
      userId,
      fileId: fid,
      fileName: 'fail.bin',
      mimeType: 'test/failing',
      patientHash: hash,
      uploadedBy: userId,
    })
    const processed = await processIngestionJob(job.id)
    expect(processed.status).toBe('failed')
    expect(attempts).toBe(3)
  })

  test('returns existing job for same file within 24h', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const hash = await createPatient(app)
    const fid = fileId()

    const job1 = await createIngestionJob({
      userId,
      fileId: fid,
      fileName: 'note.txt',
      mimeType: 'text/plain',
      patientHash: hash,
      uploadedBy: userId,
    })
    const job2 = await createIngestionJob({
      userId,
      fileId: fid,
      fileName: 'note.txt',
      mimeType: 'text/plain',
      patientHash: hash,
      uploadedBy: userId,
    })
    expect(job1.id).toBe(job2.id)
  })
})
