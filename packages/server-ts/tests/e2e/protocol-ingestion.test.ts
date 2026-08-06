import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import { createIngestionJob, processIngestionJob } from '../../src/modules/ingestion/ingestion.service.js'
import prisma from '../../src/common/prisma.js'

const protocolText = `
Study: NSCLC Phase II Trial
Inclusion:
- Histologically confirmed NSCLC
- Age 18-75
- ECOG 0-1
Exclusion:
- Active brain metastases
- Severe cardiac disease
Safety:
- DLT: Grade >= 3 neutropenia lasting >7 days
Schedule:
- Screening (Day -28 to -1): CT chest, labs, ECG
- Cycle 1 Day 1 (Day 1): Pembrolizumab infusion
`

function mockJsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const target = typeof url === 'string' ? url : url.toString()
      if (target.includes('deepseek.com')) {
        return mockJsonResponse({
          choices: [{
            message: {
              content: JSON.stringify({
                inclusion: ['Histologically confirmed NSCLC', 'Age 18-75', 'ECOG 0-1'],
                exclusion: ['Active brain metastases', 'Severe cardiac disease'],
                safety: [{ name: 'DLT', rule: 'Grade >= 3 neutropenia lasting >7 days', grade: 3 }],
                schedule: [
                  { visit: 'Screening', timing: 'Day -28 to -1', assessments: ['CT chest', 'labs', 'ECG'] },
                  { visit: 'Cycle 1 Day 1', timing: 'Day 1', assessments: ['Pembrolizumab infusion'] },
                ],
              }),
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
        })
      }
      return new Response('not found', { status: 404 })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('Protocol ingestion', () => {
  async function createStudy(app: any, userId: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/research/studies',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { display_name: 'NSCLC Phase II', short_code: 'NSCLC-02' },
    })
    expect(res.statusCode).toBe(200)
    return JSON.parse(res.payload).study_id
  }

  test('extracts rules from protocol text and persists pending StudyProtocolRule records', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const studyId = await createStudy(app, userId)

    const job = await createIngestionJob({
      userId,
      fileId: 'protocol_001',
      fileName: 'protocol.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      studyId,
      uploadedBy: userId,
      extractedText: protocolText,
    })

    const processed = await processIngestionJob(job.id)
    expect(processed.status).toBe('awaiting_review')

    const rules = await (prisma as any).studyProtocolRule.findMany({ where: { studyId } })
    expect(rules.length).toBeGreaterThanOrEqual(4)
    expect(rules.some((r: any) => r.category === 'inclusion' && r.status === 'pending')).toBe(true)
    expect(rules.some((r: any) => r.category === 'schedule' && r.status === 'pending')).toBe(true)
  }, 30000)

  test('confirming a schedule rule creates a StudyEvent and assessment', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const studyId = await createStudy(app, userId)

    const job = await createIngestionJob({
      userId,
      fileId: 'protocol_002',
      fileName: 'protocol.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      studyId,
      uploadedBy: userId,
      extractedText: protocolText,
    })
    await processIngestionJob(job.id)

    const scheduleRule = await (prisma as any).studyProtocolRule.findFirst({
      where: { studyId, category: 'schedule' },
    })
    expect(scheduleRule).toBeTruthy()

    const confirm = await app.inject({
      method: 'POST',
      url: `/api/v1/research/studies/${studyId}/protocol-rules/${scheduleRule.id}/confirm`,
      headers: await authHeader(),
    })
    expect(confirm.statusCode).toBe(200)

    const confirmed = await (prisma as any).studyProtocolRule.findUnique({ where: { id: scheduleRule.id } })
    expect(confirmed.status).toBe('confirmed')

    const events = await (prisma as any).studyEvent.findMany({ where: { studyId } })
    expect(events.length).toBeGreaterThanOrEqual(1)

    const assessments = await (prisma as any).researchAssessment.findMany({ where: { studyId } })
    expect(assessments.length).toBeGreaterThanOrEqual(1)
  }, 30000)

  test('rejecting a rule marks it rejected', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const studyId = await createStudy(app, userId)

    const job = await createIngestionJob({
      userId,
      fileId: 'protocol_003',
      fileName: 'protocol.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      studyId,
      uploadedBy: userId,
      extractedText: protocolText,
    })
    await processIngestionJob(job.id)

    const rule = await (prisma as any).studyProtocolRule.findFirst({
      where: { studyId, category: 'exclusion' },
    })
    expect(rule).toBeTruthy()

    const reject = await app.inject({
      method: 'DELETE',
      url: `/api/v1/research/studies/${studyId}/protocol-rules/${rule.id}`,
      headers: await authHeader(),
    })
    expect(reject.statusCode).toBe(200)

    const updated = await (prisma as any).studyProtocolRule.findUnique({ where: { id: rule.id } })
    expect(updated.status).toBe('rejected')
  }, 30000)

  test('re-analysis supersedes previous pending rules', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const studyId = await createStudy(app, userId)

    const job1 = await createIngestionJob({
      userId,
      fileId: 'protocol_v1',
      fileName: 'protocol_v1.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      studyId,
      uploadedBy: userId,
      extractedText: protocolText,
    })
    await processIngestionJob(job1.id)

    const firstVersion = (await (prisma as any).studyProtocolRule.findFirst({ where: { studyId } })).version

    const job2 = await createIngestionJob({
      userId,
      fileId: 'protocol_v2',
      fileName: 'protocol_v2.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      studyId,
      uploadedBy: userId,
      extractedText: protocolText,
    })
    await processIngestionJob(job2.id)

    const rules = await (prisma as any).studyProtocolRule.findMany({ where: { studyId } })
    const superseded = rules.filter((r: any) => r.status === 'superseded')
    const pending = rules.filter((r: any) => r.status === 'pending')
    expect(superseded.length).toBeGreaterThan(0)
    expect(pending.length).toBeGreaterThan(0)
    expect(pending[0].version).toBeGreaterThan(firstVersion)
  }, 30000)
})
