import Fastify from 'fastify'
import { v4 as uuid } from 'uuid'
import { generateDocx } from './handlers/docx.js'
import { generatePptx } from './handlers/pptx.js'
import { convertToPdf } from './handlers/pdf.js'
import { renderPlot } from './handlers/plot.js'
import { renderTable } from './handlers/table.js'
import { previewFile } from './handlers/preview.js'
import { getDownloadUrl, getLocalFile, localDownloadUrl, downloadUrlTtlSeconds } from './storage.js'
import { PersistentJobStore, type JobRecord } from './job-store.js'
import { runJob } from './job-runner.js'
import { createReadStream, existsSync } from 'fs'
import { renderJobType, type RenderJobType } from '@heurion/contracts'
import { enqueueJobRequestSchema, previewPayloadSchema } from '@heurion/contracts'

// #446: persistent job store (JSONL) — jobs + fileId index survive restarts.
const jobStore = new PersistentJobStore()

// #656: jobs left `running` by a crashed process can never complete.
const recovered = jobStore.recoverInterrupted()
if (recovered > 0) console.log(`[JOB-STORE] recovered ${recovered} interrupted job(s)`)

// #652: single job-type namespace. Keys are the renderJobType enum from
// @heurion/contracts — the same values the control plane submits
// (sidecar.*). Keep in sync with contracts/src/index.ts.
// #686: handler signature typed unknown→unknown — payload validation lives
// in each handler (contracts schemas), not as an untyped passthrough.
const HANDLERS: Record<RenderJobType, (payload: unknown) => Promise<unknown>> = {
  'sidecar.generate_docx': (p) => generateDocx(p),
  'sidecar.generate_pptx': (p) => generatePptx(p),
  'sidecar.render_table': (p) => renderTable(p),
  'sidecar.render_plot': (p) => renderPlot(p),
  'sidecar.convert_to_pdf': (p) => convertToPdf(p),
  'sidecar.preview_file': (p) => previewFile(p),
}

function isAuthorized(token: string | undefined): boolean {
  const expected = process.env.WORKER_API_TOKEN
  // #791: fail-closed — an unset/empty token must never open the API (the
  // old `!expected ||` made "misconfigured" equivalent to "unprotected",
  // and the compose file's empty default made that the reachable state).
  if (!expected) return false
  return token === expected
}

async function main() {
  // #791: fail-closed auth means an unset token bricks the API — warn loudly
  // at boot so the operator knows it is a configuration problem, not a bug.
  if (!process.env.WORKER_API_TOKEN) {
    console.warn('[AUTH] WORKER_API_TOKEN is not set — ALL requests will be rejected (fail-closed, #791). Set it in the worker env/compose.')
  }
  // #441: default 8002 — the control plane (server-ts) owns 8001. Docker
  // compose overrides this explicitly (8001:8001 on the host).
  const port = parseInt(process.env.SERVER_PORT || '8002', 10)
  const host = process.env.SERVER_HOST || '0.0.0.0'
  const app = Fastify({
    logger: true,
    // #771: preview_file 以 base64 直传文件字节（50MB 文件 ≈ 67MB JSON），
    // 默认 1MB bodyLimit 无法承载。
    bodyLimit: parseInt(process.env.WORKER_BODY_LIMIT || String(96 * 1024 * 1024), 10),
  })

  // #791: auth runs in onRequest — BEFORE body parsing. preHandler fires
  // after the (96MB) body has been received and buffered, so an unauthenticated
  // caller could force the worker to buffer + JSON.parse huge payloads and
  // only then get a 401. healthz stays public (compose healthcheck).
  app.addHook('onRequest', (request, reply, done) => {
    if (request.url === '/healthz' || request.method === 'OPTIONS') return done()
    const token = (request.headers['x-worker-token'] || request.headers['authorization']) as string | undefined
    if (!isAuthorized(token)) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
    done()
  })

  app.get('/healthz', async () => 'ok')

  app.post('/api/v1/jobs', async (request, reply) => {
    // #678: entry validation — reject malformed envelopes before they reach
    // the handlers (was: untyped body, illegal payloads surfaced as
    // pdfkit/other internal errors).
    const parsed = enqueueJobRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues.map((i) => i.message).join('; ') || 'invalid job request' })
    }
    const { type, payload, callback_url } = parsed.data

    // #790: preview payload 此前零校验（CONTENT_SCHEMAS 里是 z.any()）—
    // 形状错错到 soffice 才炸。入口 zod 一刀（其余 jobType 的内容在
    // 控制面 LLM 出口已过 validateRenderContent，不重复）。
    if (type === 'sidecar.preview_file') {
      const check = previewPayloadSchema.safeParse(payload || {})
      if (!check.success) {
        return reply.status(400).send({ error: check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') || 'invalid preview payload' })
      }
    }

      const id = uuid()
      const job = jobStore.create(id, type)

      // #686: 执行状态机收敛到 job-runner.runJob（并发上限/文件索引/
      // callback 通知在单点维护）— HANDLERS 已是穷举 Record,此处不再有
      // Unknown job type 分支。
      void runJob({
        jobStore,
        id,
        type: type as RenderJobType,
        payload: payload || {},
        handler: HANDLERS[type as RenderJobType],
        callbackUrl: callback_url,
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
