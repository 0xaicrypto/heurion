import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import { getUserContext } from '../chat/user-context.js'
import { getUserTools, getEnabledTools } from '../../evolution/cascade-gaps.js'

/**
 * Stub endpoints that proxy was forwarding to Python.
 * All return empty/mock data so the TS backend is fully self-contained.
 */
export async function stubRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // ── Archive patient ──
  app.post('/api/v1/dicom/patients/:hash/archive', async (request) => {
    return { archived: true, patient_hash: (request.params as any).hash }
  })

  // ── Report download ──
  app.get('/api/v1/report/pdf/:hash', async (request, reply) => {
    reply.header('Content-Type', 'application/pdf')
    return Buffer.from('%PDF-stub', 'utf-8')
  })

  // ── Memory medications ──
  app.get('/api/v1/memory/patient/:patientHash/medications', async () => {
    return { medications: [] }
  })

  // ── Workflows ──
  app.get('/api/v1/workflows', async () => {
    return { workflows: [] }
  })
  app.get('/api/v1/workflows/packs', async () => {
    return { packs: [] }
  })
  app.post('/api/v1/workflows/packs/:id/install', async (request) => {
    return { installed: true, pack_id: (request.params as any).id }
  })
  app.get('/api/v1/workflows/runs', async () => {
    return { runs: [] }
  })

  // ── Schedule ──
  app.get('/api/v1/schedule/list', async (request) => {
    return { tasks: [] }
  })
  app.delete('/api/v1/schedule/:id', async (request) => {
    return { task_id: (request.params as any).id }
  })

  // ── Export ──
  app.post('/api/v1/export/bundle', async (request, reply) => {
    reply.header('Content-Type', 'application/json')
    return { bundle: {}, exported_at: new Date().toISOString() }
  })

  // ── Sandbox ──
  app.post('/api/v1/sandbox/execute', async (request) => {
    return { output: '[sandbox stub]', exit_code: 0 }
  })

  // ── Chat files ──
  app.get('/api/v1/chat/files', async () => {
    return { files: [] }
  })

  // ── Feedback ──
  app.post('/feedback', async () => {
    return { ok: true }
  })

  // ── Knowledge & Facts API ──
  app.get('/api/v1/knowledge', async (request: any) => {
    const ctx = getUserContext(request.user!.userId)
    return { articles: ctx.knowledge.all() }
  })
  app.get('/api/v1/facts', async (request: any) => {
    const ctx = getUserContext(request.user!.userId)
    return { facts: ctx.facts.all() }
  })
  app.put('/api/v1/facts/:id', async (request: any) => {
    const ctx = getUserContext(request.user!.userId)
    const patch = request.body as any
    const facts = ctx.facts.all()
    const idx = facts.findIndex((f: any) => f.id === request.params.id)
    if (idx === -1) return { error: 'Not found' }
    if (patch.content) facts[idx].content = patch.content
    if (patch.category) facts[idx].category = patch.category
    if (patch.importance) facts[idx].importance = patch.importance
    if (patch.sourceType) facts[idx].sourceType = patch.sourceType
    facts[idx].updatedAt = Date.now()
    ctx.facts.commit()
    return { fact: facts[idx] }
  })
  app.delete('/api/v1/facts/:id', async (request: any) => {
    const ctx = getUserContext(request.user!.userId)
    const ok = ctx.facts.remove(request.params.id)
    if (ok) ctx.facts.commit()
    return { deleted: ok }
  })
  // ── Tool Store ──
  app.get('/api/v1/knowledge/tools', async (request: any) => {
    return { tools: getUserTools(request.user!.userId) }
  })
  app.get('/api/v1/knowledge/tools/enabled', async (request: any) => {
    return { tools: getEnabledTools(request.user!.userId) }
  })
  app.post('/api/v1/report/pdf', async (request: any) => {
    return { path: '/tmp/report.pdf', bytes: 0, created_at: Math.floor(Date.now()/1000), patient_hash: request.body?.patient_hash || '' }
  })
}
