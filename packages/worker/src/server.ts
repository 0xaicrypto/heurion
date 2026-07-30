import Fastify from 'fastify'
import { v4 as uuid } from 'uuid'
import { generateDocx } from './handlers/docx.js'
import { generatePptx } from './handlers/pptx.js'
import { convertToPdf } from './handlers/pdf.js'
import { renderPlot } from './handlers/plot.js'
import { renderTable } from './handlers/table.js'
import { getDownloadUrl } from './storage.js'

const JOBS = new Map<string, any>()

interface JobRecord {
  id: string
  type: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  created_at: number
  completed_at?: number
  result?: any
  error?: string
}

const HANDLERS: Record<string, (payload: any, tenant?: any) => Promise<any>> = {
  'sidecar.generate_docx': (p) => generateDocx(p, p.tenant),
  'sidecar.generate_pptx': (p) => generatePptx(p),
  'sidecar.render_table': (p) => renderTable(p),
  'sidecar.render_plot': (p) => renderPlot(p),
  'sidecar.convert_to_pdf': (p) => convertToPdf(p),
  'sidecar.heurion/docx.generate_docx': (p) => generateDocx(p, p.tenant),
  'sidecar.heurion/pptx.generate_pptx': (p) => generatePptx(p),
  'sidecar.heurion/table.render_table': (p) => renderTable(p),
  'sidecar.heurion/plot.render_plot': (p) => renderPlot(p),
  'sidecar.heurion/pdf.convert_to_pdf': (p) => convertToPdf(p),
}

function isAuthorized(token: string | undefined): boolean {
  const expected = process.env.WORKER_API_TOKEN
  return !expected || token === expected
}

async function main() {
  const port = parseInt(process.env.SERVER_PORT || '8001', 10)
  const host = process.env.SERVER_HOST || '0.0.0.0'
  const app = Fastify({ logger: true })

  app.addHook('preHandler', (request, reply, done) => {
    if (request.url === '/healthz') return done()
    const token = (request.headers['x-worker-token'] || request.headers['authorization']) as string | undefined
    if (!isAuthorized(token)) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
    done()
  })

  app.get('/healthz', async () => 'ok')

  app.post<{ Body: { type: string; payload?: any; tenant?: any; callback_url?: string } }>(
    '/api/v1/jobs',
    async (request, reply) => {
      const { type, payload, tenant, callback_url } = request.body
      if (!type) {
        return reply.status(400).send({ error: 'type is required' })
      }

      const id = uuid()
      const job: JobRecord = { id, type, status: 'pending', created_at: Date.now() / 1000 }
      JOBS.set(id, job)

      setImmediate(async () => {
        const handler = HANDLERS[type]
        if (!handler) {
          job.status = 'failed'
          job.error = `Unknown job type: ${type}`
          job.completed_at = Date.now() / 1000
          return
        }

        job.status = 'running'
        try {
          const result = await handler(payload || {}, tenant)
          job.status = 'completed'
          job.result = result
        } catch (err: any) {
          job.status = 'failed'
          job.error = err.message || 'Handler failed'
        }
        job.completed_at = Date.now() / 1000
      })

      return {
        job_id: id,
        status: job.status,
        created_at: job.created_at,
      }
    },
  )

  app.get('/api/v1/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const job = JOBS.get(id)
    if (!job) return reply.status(404).send({ error: 'job not found' })
    return {
      job_id: job.id,
      status: job.status,
      created_at: job.created_at,
      completed_at: job.completed_at,
      result: job.result,
      error: job.error,
    }
  })

  app.get('/api/v1/files/:fileId/download', async (request, reply) => {
    const { fileId } = request.params as { fileId: string }
    for (const job of JOBS.values()) {
      if (job.result?.fileId === fileId || job.result?.s3Key) {
        const url = getDownloadUrl(job.result.s3Key)
        return { file_id: fileId, file_name: job.result.fileName, mime_type: job.result.mimeType, download_url: url, expires_in: 3600 }
      }
    }
    return reply.status(404).send({ error: 'file not found' })
  })

  await app.listen({ host, port })
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
