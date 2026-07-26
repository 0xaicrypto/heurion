import type { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import { createExecutionPlaneService } from './execution-plane.service.js'

const service = createExecutionPlaneService()

const ALLOWED_SIDEcar_TYPES = [
  'sidecar.generate_docx',
  'sidecar.generate_pptx',
  'sidecar.render_table',
  'sidecar.render_plot',
  'sidecar.convert_to_pdf',
]

export async function executionRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // Generic job enqueue — agent/tool layer can call this directly.
  app.post('/api/v1/execution/jobs', async (request, reply) => {
    const body = request.body as {
      type: string
      payload?: Record<string, unknown>
      tenant?: { userId?: string; workspaceId?: string }
      callbackUrl?: string
    }
    if (!body.type) {
      return reply.status(400).send({ error: 'job type is required' })
    }
    const job = await service.enqueue({
      type: body.type,
      payload: body.payload ?? {},
      tenant: body.tenant ?? { userId: request.user!.userId },
      callbackUrl: body.callbackUrl,
    })
    return job
  })

  // Convenience endpoint for UI/chat: enqueue a Sidecar render job using
  // the current authenticated user as the tenant.
  app.post('/api/v1/execution/render', async (request, reply) => {
    const body = request.body as {
      type: string
      payload?: Record<string, unknown>
      callbackUrl?: string
    }
    if (!body.type || !ALLOWED_SIDEcar_TYPES.includes(body.type)) {
      return reply.status(400).send({ error: 'invalid or unsupported sidecar render type' })
    }
    const job = await service.enqueue({
      type: body.type,
      payload: body.payload ?? {},
      tenant: { userId: request.user!.userId },
      callbackUrl: body.callbackUrl,
    })
    return job
  })

  app.get('/api/v1/execution/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const status = await service.getStatus(id)
    if (!status) {
      return reply.status(404).send({ error: 'job not found' })
    }
    return status
  })

  // Proxies to the worker to retrieve a short-lived presigned download URL
  // for a rendered Sidecar output file.
  app.get('/api/v1/execution/files/:fileId/download', async (request, reply) => {
    const { fileId } = request.params as { fileId: string }
    const urlInfo = await service.getDownloadUrl(fileId)
    if (!urlInfo) {
      return reply.status(404).send({ error: 'file not found' })
    }
    return urlInfo
  })
}
