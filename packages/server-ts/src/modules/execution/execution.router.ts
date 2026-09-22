import type { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import prisma from '../../common/prisma.js'
import { createExecutionPlaneService } from './execution-plane.service.js'

const service = createExecutionPlaneService()

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
    // #中-13: tenant.userId 来自认证身份，绝不接受 body 伪造（此前会把作业
    // 归属成任意 userId）。workspaceId 可透传。
    const job = await service.enqueue({
      type: body.type,
      payload: body.payload ?? {},
      tenant: { userId: request.user!.userId, workspaceId: body.tenant?.workspaceId },
      callbackUrl: body.callbackUrl,
    })
    return job
  })

  app.get('/api/v1/execution/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const userId = request.user!.userId
    // #中-13: 归属校验 — 缺记录/他人记录一律 404（不泄露存在性）。
    const owner = await prisma.executionJobOwner.findUnique({ where: { jobId: id } }).catch(() => null)
    if (!owner || owner.userId !== userId) {
      return reply.status(404).send({ error: 'job not found' })
    }
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
    const userId = request.user!.userId
    // #中-13: file → owner 校验（轮询终态时登记）。缺记录 404（fail-closed）。
    const owner = await prisma.executionJobOwner.findFirst({ where: { fileId } }).catch(() => null)
    if (!owner || owner.userId !== userId) {
      return reply.status(404).send({ error: 'file not found' })
    }
    const urlInfo = await service.getDownloadUrl(fileId)
    if (!urlInfo) {
      return reply.status(404).send({ error: 'file not found' })
    }
    return urlInfo
  })
}
