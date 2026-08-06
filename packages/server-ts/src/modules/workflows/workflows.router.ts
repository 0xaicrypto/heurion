import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import { WorkflowService } from './workflow.service.js'

// Global service, lazily initialized with the first user's base dir.
// In production this should be per-user, but for MVP a shared instance is fine.
let _service: WorkflowService | null = null

function getService(): WorkflowService {
  if (!_service) {
    const baseDir = process.env.TWIN_BASE_DIR || process.env.HOME || '/tmp'
    _service = new WorkflowService(baseDir)
  }
  return _service
}

export async function workflowsRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  app.get('/api/v1/workflows', async (request) => {
    const userId = request.user!.userId
    return { workflows: getService().list(userId) }
  })

  app.post('/api/v1/workflows', async (request, reply) => {
    const userId = request.user!.userId
    const body = (request.body as any) || {}
    // 边界审计（#253）: name is required — an empty body must not create
    // a nameless workflow.
    if (!body.name || !String(body.name).trim()) {
      return reply.status(400).send({ error: 'name required' })
    }
    const wf = getService().create({
      name: body.name,
      description: body.description,
      category: body.category,
      steps: body.steps,
      inputs: body.inputs,
    }, userId)
    return wf
  })

  app.get('/api/v1/workflows/:id', async (request, reply) => {
    const { id } = request.params as any
    const wf = getService().get(id)
    if (!wf) return reply.status(404).send({ error: 'Workflow not found' })
    return wf
  })

  app.put('/api/v1/workflows/:id', async (request, reply) => {
    const { id } = request.params as any
    const body = request.body as any
    const wf = getService().update(id, {
      name: body.name,
      description: body.description,
      category: body.category,
      steps: body.steps,
      inputs: body.inputs,
    })
    if (!wf) return reply.status(404).send({ error: 'Workflow not found' })
    return wf
  })

  app.delete('/api/v1/workflows/:id', async (request, reply) => {
    const { id } = request.params as any
    const ok = getService().delete(id)
    if (!ok) return reply.status(404).send({ error: 'Workflow not found' })
    return { deleted: true }
  })

  app.get('/api/v1/workflows/runs', async (request) => {
    const userId = request.user!.userId
    const q = request.query as any
    return { runs: getService().listRuns(userId, q.workflow_id) }
  })

  app.get('/api/v1/workflows/runs/:runId', async (request, reply) => {
    const { runId } = request.params as any
    const run = getService().getRun(runId)
    if (!run) return reply.status(404).send({ error: 'Run not found' })
    return run
  })

  app.post('/api/v1/workflows/:id/run', async (request, reply) => {
    const { id } = request.params as any
    const userId = request.user!.userId
    const body = (request.body || {}) as any
    const wf = getService().get(id)
    if (!wf) return reply.status(404).send({ error: 'Workflow not found' })
    const run = getService().createRun(id, userId, body.input || {})
    return run
  })

  app.get('/api/v1/workflows/packs', async () => {
    return { packs: getService().listPacks() }
  })

  app.post('/api/v1/workflows/packs/:packId/install', async (request) => {
    const userId = request.user!.userId
    const { packId } = request.params as any
    const installed = getService().installPack(packId, userId)
    return { installed: true, pack_id: packId, count: installed.length }
  })
}
