import { describe, test, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import { getApp, authHeader, getAuthUserId } from './setup.js'
import { createIngestionJob, processIngestionJob } from '../src/modules/ingestion/ingestion.service.js'

beforeEach(() => {
  vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const target = typeof url === 'string' ? url : url.toString()
      if (target.includes('generativelanguage.googleapis.com')) {
        return new Response(
          JSON.stringify({
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    region: '胸部',
                    modality: 'CT',
                    findings: ['右肺上叶可见小结节，直径约5mm'],
                    impression: '良性结节可能大，建议随访',
                    confidence: 'medium',
                  }),
                }],
              },
            }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const dicomSource = path.resolve(import.meta.dirname, '../sample-chest-ct.dcm')
const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

describe('Imaging / DICOM ingestion', () => {
  let app: FastifyInstance
  let userId: string
  let uploadDir: string

  beforeAll(async () => {
    uploadDir = fs.mkdtempSync(path.join('/tmp', 'imaging-test-'))
    process.env.UPLOAD_DIR = uploadDir

    app = await getApp()
    userId = await getAuthUserId()

    const userDir = path.join(uploadDir, userId)
    fs.mkdirSync(userDir, { recursive: true })
    fs.copyFileSync(dicomSource, path.join(userDir, 'ct.dcm'))
    fs.writeFileSync(path.join(userDir, 'report.png'), Buffer.from(tinyPngBase64, 'base64'))
  })

  afterAll(() => {
    fs.rmSync(uploadDir, { recursive: true, force: true })
    delete process.env.UPLOAD_DIR
  })

  async function createPatient(initials = 'IMG') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/dicom/patients/register-manual',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { initials, age: 55, sex: 'F' },
    })
    expect(res.statusCode).toBe(200)
    return JSON.parse(res.payload).patient_hash
  }

  test('DICOM upload produces pending imaging entry with AI Vision findings', async () => {
    const hash = await createPatient()

    const job = await createIngestionJob({
      userId,
      fileId: 'ct.dcm',
      fileName: 'ct.dcm',
      mimeType: 'application/dicom',
      patientHash: hash,
      uploadedBy: userId,
    })

    const processed = await processIngestionJob(job.id)
    expect(processed.status).toBe('awaiting_review')
    expect(processed.confidence).toBe('medium')

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${hash}/medical-records?type=imaging`,
      headers: await authHeader(),
    })
    const records = JSON.parse(list.payload).records
    expect(records.length).toBe(1)
    expect(records[0].type).toBe('imaging')
    expect(records[0].title).toContain('[AI Vision]')
    expect(records[0].content).toContain('影像所见')
    expect(records[0].content).toContain('右肺上叶可见小结节')
    expect(records[0].aiSummary).toContain('良性结节可能大')
    expect(records[0].status).toBe('pending_review')
    expect(records[0].rawJson.source).toBe('dicom')

    const approvals = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: await authHeader(),
    })
    const requests = JSON.parse(approvals.payload).requests
    expect(requests.some((r: any) => r.targetId === records[0].id)).toBe(true)
  }, 30000)

  test('image upload produces pending imaging entry via Gemini Vision', async () => {
    const hash = await createPatient('IMG2')

    const job = await createIngestionJob({
      userId,
      fileId: 'report.png',
      fileName: 'report.png',
      mimeType: 'image/png',
      patientHash: hash,
      uploadedBy: userId,
    })

    const processed = await processIngestionJob(job.id)
    expect(processed.status).toBe('awaiting_review')

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${hash}/medical-records?type=imaging`,
      headers: await authHeader(),
    })
    const records = JSON.parse(list.payload).records
    expect(records.length).toBeGreaterThanOrEqual(1)
    expect(records[0].type).toBe('imaging')
    expect(records[0].status).toBe('pending_review')
    expect(records[0].rawJson.source).toBe('image')
  }, 30000)

  test('doctor can confirm or reject an AI imaging entry', async () => {
    const hash = await createPatient('IMG3')

    const job = await createIngestionJob({
      userId,
      fileId: 'ct.dcm',
      fileName: 'ct.dcm',
      mimeType: 'application/dicom',
      patientHash: hash,
      uploadedBy: userId,
    })
    await processIngestionJob(job.id)

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${hash}/medical-records?type=imaging`,
      headers: await authHeader(),
    })
    const record = JSON.parse(list.payload).records[0]

    const approvals = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: await authHeader(),
    })
    const request = JSON.parse(approvals.payload).requests.find((r: any) => r.targetId === record.id)
    expect(request).toBeDefined()

    const confirm = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${request.id}/confirm`,
      headers: await authHeader(),
    })
    expect(confirm.statusCode).toBe(200)

    const confirmed = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${hash}/medical-records/${record.id}`,
      headers: await authHeader(),
    })
    expect(JSON.parse(confirmed.payload).status).toBe('confirmed')
  }, 30000)

  test('invalid DICOM file fails ingestion job after retries', async () => {
    const hash = await createPatient('IMG4')
    const badPath = path.join(uploadDir, userId, 'bad.dcm')
    fs.writeFileSync(badPath, 'this is not a valid DICOM file')

    const job = await createIngestionJob({
      userId,
      fileId: 'bad.dcm',
      fileName: 'bad.dcm',
      mimeType: 'application/dicom',
      patientHash: hash,
      uploadedBy: userId,
    })

    const processed = await processIngestionJob(job.id)
    expect(processed.status).toBe('failed')
    expect(processed.failedReason).toContain('DICOM')
  }, 30000)
})
