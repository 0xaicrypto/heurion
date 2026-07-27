import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import { getUserContext } from '../chat/user-context.js'
import { getUserTools, getEnabledTools, deleteUserTool } from '../../evolution/cascade-gaps.js'
import { PrismaKnowledgeGapService } from '../knowledge/knowledge-gap.service.js'

const gapService = new PrismaKnowledgeGapService()

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
    const fact = ctx.memory.editFact(request.params.id, {
      content: patch.content,
      category: patch.category,
      importance: patch.importance,
      sourceType: patch.sourceType,
    })
    if (!fact) return { error: 'Not found' }
    return { fact }
  })
  app.delete('/api/v1/facts/:id', async (request: any) => {
    const ctx = getUserContext(request.user!.userId)
    const ok = ctx.memory.deleteFact(request.params.id)
    return { deleted: ok }
  })

  // ── Bulk deletes ──
  app.delete('/api/v1/knowledge/articles', async (request: any) => {
    const ctx = getUserContext(request.user!.userId)
    const ids = (request.body as any)?.ids
    if (!Array.isArray(ids)) return { deleted: 0 }
    let deleted = 0
    for (const id of ids) {
      if (ctx.memory.deleteArticle(String(id))) deleted++
    }
    return { deleted }
  })
  app.delete('/api/v1/knowledge/facts', async (request: any) => {
    const ctx = getUserContext(request.user!.userId)
    const ids = (request.body as any)?.ids
    if (!Array.isArray(ids)) return { deleted: 0 }
    let deleted = 0
    for (const id of ids) {
      if (ctx.memory.deleteFact(String(id))) deleted++
    }
    return { deleted }
  })
  app.delete('/api/v1/knowledge/gaps', async (request: any) => {
    const userId = request.user!.userId
    const ids = (request.body as any)?.ids
    if (!Array.isArray(ids)) return { deleted: 0 }
    let deleted = 0
    for (const id of ids) {
      const gap = await gapService.getById(String(id))
      if (gap && gap.userId === userId) {
        if (await gapService.delete(gap.id)) deleted++
      }
    }
    return { deleted }
  })
  app.delete('/api/v1/knowledge/tools', async (request: any) => {
    const userId = request.user!.userId
    const ids = (request.body as any)?.ids
    if (!Array.isArray(ids)) return { deleted: 0 }
    let deleted = 0
    for (const id of ids) {
      if (deleteUserTool(userId, String(id))) deleted++
    }
    return { deleted }
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
