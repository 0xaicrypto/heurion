import Fastify from 'fastify'
import { v4 as uuid } from 'uuid'
import { generateDocx } from './handlers/docx.js'
import { generatePptx } from './handlers/pptx.js'
import { convertToPdf } from './handlers/pdf.js'
import { renderPlot } from './handlers/plot.js'
import { renderTable } from './handlers/table.js'
import { getDownloadUrl, getLocalFile, localDownloadUrl, downloadUrlTtlSeconds } from './storage.js'
import { PersistentJobStore, type JobRecord } from './job-store.js'
import { createReadStream, existsSync } from 'fs'

// #446: persistent job store (JSONL) — jobs + fileId index survive restarts.
const jobStore = new PersistentJobStore()

// #453: single job-type namespace — sidecar.{pluginId}.{toolName}.
// The pre-plugin era names (sidecar.generate_docx, ...) were removed.
const HANDLERS: Record<string, (payload: any, tenant?: any) => Promise<any>> = {
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
  // #441: default 8002 — the control plane (server-ts) owns 8001. Docker
  // compose overrides this explicitly (8001:8001 on the host).
  const port = parseInt(process.env.SERVER_PORT || '8002', 10)
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
      const job = jobStore.create(id, type)

      setImmediate(async () => {
        const handler = HANDLERS[type]
        if (!handler) {
          jobStore.update(id, { status: 'failed', error: `Unknown job type: ${type}`, completed_at: Date.now() / 1000 })
          return
        }

        jobStore.update(id, { status: 'running' })
        try {
          const result = await handler(payload || {}, tenant)
          jobStore.update(id, { status: 'completed', result, completed_at: Date.now() / 1000 })
          // #446: index the produced file for O(1) download lookups.
          if (result?.file_id) {
            jobStore.indexFile({
              fileId: String(result.file_id),
              jobId: id,
              fileName: String(result.file_name || 'output'),
              mimeType: String(result.mime_type || 'application/octet-stream'),
            })
          }
          // #449: fire-and-forget completion callback.
          if (callback_url) {
            fetch(callback_url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ job_id: id, status: 'completed', result, error: undefined }),
            }).catch(() => {})
          }
        } catch (err: any) {
          jobStore.update(id, { status: 'failed', error: err.message || 'Handler failed', completed_at: Date.now() / 1000 })
          if (callback_url) {
            fetch(callback_url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ job_id: id, status: 'failed', error: err.message || 'Handler failed' }),
            }).catch(() => {})
          }
        }
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
    const job = jobStore.get(id)
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

  // #447: honest download info — real presigned S3 URL (1h) in S3 mode, or
  // the local proxy endpoint in local mode. expires_in is the true TTL.
  app.get('/api/v1/files/:fileId/download', async (request, reply) => {
    const { fileId } = request.params as { fileId: string }
    // #446: O(1) file-index lookup (no job-map scan).
    const entry = jobStore.getFileEntry(fileId)
    const job = entry ? jobStore.get(entry.jobId) : null
    if (!job) return reply.status(404).send({ error: 'file not found' })
    const result = (job.result || {}) as Record<string, unknown>

    let url: string | null = null
    if (result.s3Key) {
      url = await getDownloadUrl(String(result.s3Key))
      if (!url) return reply.status(500).send({ error: 'download URL generation failed' })
    } else if (result.fileId) {
      url = localDownloadUrl(String(result.fileId))
    }
    if (!url) return reply.status(404).send({ error: 'file not found' })

    return {
      file_id: fileId,
      file_name: entry?.fileName || String(result.fileName || 'output'),
      mime_type: entry?.mimeType || String(result.mimeType || 'application/octet-stream'),
      download_url: url,
      expires_in: downloadUrlTtlSeconds(),
    }
  })

  // Local-mode file content proxy (used by localDownloadUrl). Auth: the
  // same worker token — the control plane proxies this through its own
  // authenticated files route.
  app.get('/api/v1/files/:fileId/content', async (request, reply) => {
    const { fileId } = request.params as { fileId: string }
    const file = getLocalFile(fileId)
    if (!file || !existsSync(file.path)) {
      return reply.status(404).send({ error: 'file not found' })
    }
    reply.header('Content-Type', file.mimeType)
    reply.header('Cache-Control', 'public, max-age=3600')
    return reply.send(createReadStream(file.path))
  })

  await app.listen({ host, port })
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
