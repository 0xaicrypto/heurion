import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import { createIngestionJob, processIngestionJob } from '../../src/modules/ingestion/ingestion.service.js'

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const target = typeof url === 'string' ? url : url.toString()
      if (target.includes('deepseek.com')) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({
              items: [
                { name: 'WBC', value: '11.2', unit: 'x10^9/L', referenceRange: '4.0-10.0', abnormal: true, interpretation: 'High' },
                { name: 'Creatinine', value: '1.3', unit: 'mg/dL', referenceRange: '0.6-1.2', abnormal: true, interpretation: 'High' },
              ],
            }) } }],
            usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
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

async function createPatient(app: any, initials = 'LAB') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/dicom/patients/register-manual',
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: { initials, age: 45, sex: 'M' },
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.payload).patient_hash
}

const labText = `
Complete Blood Count (CBC)
WBC: 11.2 x10^9/L (ref: 4.0-10.0) — High
RBC: 4.5 x10^12/L (ref: 4.2-5.4)
Hemoglobin: 13.5 g/dL (ref: 13.0-17.0)
Platelets: 250 x10^9/L (ref: 150-400)

Basic Metabolic Panel
Glucose: 95 mg/dL (ref: 70-100)
Creatinine: 1.3 mg/dL (ref: 0.6-1.2) — High
`

describe('Lab ingestion', () => {
  test('extracts lab items from report text and creates pending lab entries', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const hash = await createPatient(app)

    const job = await createIngestionJob({
      userId,
      fileId: 'lab_report_001',
      fileName: 'lab_report.pdf',
      mimeType: 'application/pdf',
      patientHash: hash,
      uploadedBy: userId,
      extractedText: labText,
    })

    const processed = await processIngestionJob(job.id)
    expect(processed.status).toBe('awaiting_review')

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${hash}/medical-records?type=lab`,
      headers: await authHeader(),
    })
    const records = JSON.parse(list.payload).records
    expect(records.length).toBeGreaterThanOrEqual(1)
    expect(records.some((r: any) => r.title.toLowerCase().includes('wbc') || r.content.toLowerCase().includes('wbc'))).toBe(true)

    const approvals = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: await authHeader(),
    })
    const requests = JSON.parse(approvals.payload).requests
    expect(requests.some((r: any) => r.targetType === 'MedicalRecordEntry' && records.some((rec: any) => rec.id === r.targetId))).toBe(true)
  }, 30000)
})
