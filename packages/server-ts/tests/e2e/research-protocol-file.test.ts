import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getApp, authHeader } from '../setup.js'

function mockJsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function buildMultipart(fields: Record<string, string>, file?: { name: string; mime: string; content: Buffer }): { body: Buffer; contentType: string } {
  const boundary = `----ptboundary${Date.now()}`
  const chunks: Buffer[] = []
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`))
  }
  if (file) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`))
    chunks.push(file.content)
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

const protocolText = `
INCLUSION: Stage IIIB/IV NSCLC, PD-L1>=1%, ECOG 0-1
EXCLUSION: EGFR/ALK positive, autoimmune disease
SAFETY: DLT evaluation Cycle 1, Grade 4 neutropenia >7 days
SCHEDULE: Screening (Day -28 to -1): CT, labs. Cycle 1 Day 1: CBC, chemistry.
`

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
                inclusion: ['Stage IIIB/IV NSCLC', 'PD-L1>=1%', 'ECOG 0-1'],
                exclusion: ['EGFR/ALK positive', 'autoimmune disease'],
                safety: [{ name: 'DLT', rule: 'Grade 4 neutropenia >7 days', grade: 4 }],
                schedule: [
                  { visit: 'Screening', timing: 'Day -28 to -1', assessments: ['CT', 'labs'] },
                  { visit: 'Cycle 1 Day 1', timing: 'Day 1', assessments: ['CBC', 'chemistry'] },
                ],
              }),
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
        })
      }
      return mockJsonResponse({ error: 'not found' }, 404)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('research protocol file upload', () => {
  test('uploading a protocol file extracts and persists pending rules', async () => {
    const app = await getApp()
    const study = await app.inject({
      method: 'POST',
      url: '/api/v1/research/studies',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ display_name: 'Protocol File Test', short_code: 'PFT' }),
    })
    const studyId = JSON.parse(study.payload).study_id

    const { body, contentType } = buildMultipart(
      {},
      { name: 'protocol.txt', mime: 'text/plain', content: Buffer.from(protocolText) },
    )
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/research/studies/${studyId}/protocol-file`,
      headers: { ...await authHeader(), 'content-type': contentType },
      payload: body,
    })
    expect(res.statusCode).toBe(200)
    const parsed = JSON.parse(res.payload)
    expect(parsed.file_name).toBe('protocol.txt')
    expect(parsed.text_length).toBeGreaterThan(0)
    expect(parsed.rules.length).toBeGreaterThan(0)
    expect(parsed.status.pending).toBe(parsed.rules.length)

    // Rules are persisted and listed as pending
    const rules = await app.inject({
      method: 'GET',
      url: `/api/v1/research/studies/${studyId}/protocol-rules`,
      headers: await authHeader(),
    })
    const { rules: persisted, status } = JSON.parse(rules.payload)
    expect(persisted.length).toBeGreaterThan(0)
    expect(status.pending).toBeGreaterThan(0)
    expect(persisted.some((r: any) => r.category === 'inclusion')).toBe(true)
    expect(persisted.some((r: any) => r.category === 'schedule')).toBe(true)
  }, 30000)

  test('uploading a non-extractable file returns 400 with a clear error', async () => {
    const app = await getApp()
    const study = await app.inject({
      method: 'POST',
      url: '/api/v1/research/studies',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ display_name: 'Bad File Test', short_code: 'BFT' }),
    })
    const studyId = JSON.parse(study.payload).study_id

    // Binary garbage with .bin extension — no extractable text
    const { body, contentType } = buildMultipart(
      {},
      { name: 'plan.bin', mime: 'application/octet-stream', content: Buffer.from([0x00, 0xff, 0x01, 0x02]) },
    )
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/research/studies/${studyId}/protocol-file`,
      headers: { ...await authHeader(), 'content-type': contentType },
      payload: body,
    })
    expect(res.statusCode).toBe(400)
    expect(res.payload).toContain('Unsupported file type')
  })
})
