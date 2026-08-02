import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { getApp, authHeader } from './setup.js'

function buildMultipart(fields: Record<string, string>, file?: { name: string; mime: string; content: Buffer }): { body: Buffer; contentType: string } {
  const boundary = `----testboundary${Date.now()}`
  const chunks: Buffer[] = []

  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`))
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
      ),
    )
    chunks.push(file.content)
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

beforeEach(() => {
  process.env.TWIN_BASE_DIR = '.nexus/test-upload-ingestion'
})

afterEach(() => {
  delete process.env.TWIN_BASE_DIR
})

async function createPatient(app: any) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/dicom/patients/register-manual',
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: { initials: 'UP', age: 40, sex: 'M' },
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.payload).patient_hash
}

describe('upload → ingestion pipeline (fix: files/upload triggers ingestion)', () => {
  test('upload with patient_hash creates an ingestion job and analysis produces a pending entry', async () => {
    const app = await getApp()
    const hash = await createPatient(app)

    const { body, contentType } = buildMultipart(
      { patient_hash: hash },
      { name: 'note.txt', mime: 'text/plain', content: Buffer.from('follow-up in 2 weeks') },
    )
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload',
      headers: { ...await authHeader(), 'content-type': contentType },
      payload: body,
    })
    expect(upload.statusCode).toBe(200)
    const uploaded = JSON.parse(upload.payload)
    expect(uploaded.ingestion_job_id).toBeTruthy()

    // Job is listed via the ingestion API
    const jobs = await app.inject({
      method: 'GET',
      url: '/api/v1/ingestion/jobs',
      headers: await authHeader(),
    })
    expect(jobs.statusCode).toBe(200)
    const { jobs: jobList } = JSON.parse(jobs.payload)
    expect(jobList.some((j: any) => j.id === uploaded.ingestion_job_id && j.fileId === uploaded.file_id)).toBe(true)

    // Upload kicks off analysis in the background; poll until it settles.
    let job: any
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const status = await app.inject({
        method: 'GET',
        url: `/api/v1/ingestion/jobs/${uploaded.ingestion_job_id}`,
        headers: await authHeader(),
      })
      job = JSON.parse(status.payload)
      if (job.status === 'awaiting_review' || job.status === 'failed') break
      await new Promise((r) => setTimeout(r, 200))
    }
    expect(job.status).toBe('awaiting_review')

    const entries = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${hash}/medical-records`,
      headers: await authHeader(),
    })
    const { records } = JSON.parse(entries.payload)
    const entry = records.find((r: any) => r.sourceJobId === uploaded.ingestion_job_id)
    expect(entry).toBeTruthy()
    expect(entry.status).toBe('pending_review')
    expect(entry.createdBy).toBe('system')
  })

  test('upload without patient_hash does not create an ingestion job', async () => {
    const app = await getApp()

    const { body, contentType } = buildMultipart(
      {},
      { name: 'orphan.txt', mime: 'text/plain', content: Buffer.from('no patient context') },
    )
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload',
      headers: { ...await authHeader(), 'content-type': contentType },
      payload: body,
    })
    expect(upload.statusCode).toBe(200)
    const uploaded = JSON.parse(upload.payload)
    expect(uploaded.ingestion_job_id).toBeNull()
  })
})
