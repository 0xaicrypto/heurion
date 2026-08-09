/**
 * #440 — genuine stubs only. Real business endpoints that once lived here
 * moved to their proper modules:
 *   - memory graph / facts / knowledge CRUD → knowledge-stores.router.ts
 *   - report PDF → report.router.ts
 *   - chat/files → files.router.ts (getChatFiles)
 * What remains: placeholder surfaces that have no implementation yet
 * (DICOM archive, medications, schedule, export bundle).
 */
import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'

export async function stubRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // ── Archive patient (placeholder — no archive model yet) ──
  app.post('/api/v1/dicom/patients/:hash/archive', async (request) => {
    return { archived: true, patient_hash: (request.params as any).hash }
  })

  // ── Memory medications (placeholder — served by graph query later) ──
  app.get('/api/v1/memory/patient/:patientHash/medications', async () => {
    return { medications: [] }
  })

  // ── Schedule (placeholder — dedicated calendar module pending) ──
  app.get('/api/v1/schedule/list', async () => {
    return { tasks: [] }
  })
  app.delete('/api/v1/schedule/:id', async (request) => {
    return { task_id: (request.params as any).id }
  })
  app.post('/api/v1/schedule/confirm', async (request: any) => {
    const { task_id } = (request.body || {}) as any
    return { ok: true, task_id: task_id || 'unknown' }
  })
  app.post('/api/v1/schedule/extract', async (request: any) => {
    const { text } = (request.body || {}) as any
    return { tasks: [], text: text || '' }
  })

  // ── Export bundle (placeholder) ──
  app.post('/api/v1/export/bundle', async (_request, reply) => {
    reply.header('Content-Type', 'application/json')
    return { bundle: {}, exported_at: new Date().toISOString() }
  })
}
