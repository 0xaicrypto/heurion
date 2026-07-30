import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import { extractPractitionerObservations } from './practitioner-extractor.service.js'
import { distillObservations } from './practitioner-distiller.service.js'
import { composeNarrative } from './practitioner-composer.service.js'
import { extractTakeaways, listTakeaways, acknowledgeTakeaway } from './session-takeaway.service.js'

export async function practitionerRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  app.post('/api/v1/practitioner/extract', async (request, reply) => {
    const { text } = request.body as any
    if (!text) return reply.status(400).send({ error: 'text required' })
    const observations = await extractPractitionerObservations(text)
    return { observations }
  })

  app.post('/api/v1/practitioner/distill', async (request, reply) => {
    const { observations } = request.body as any
    if (!observations?.length) return reply.status(400).send({ error: 'observations required' })
    const insights = await distillObservations(observations)
    return { insights }
  })

  app.post('/api/v1/practitioner/compose', async (request, reply) => {
    const { observations, insights, narrative_type, patient_context } = request.body as any
    if (!observations?.length) return reply.status(400).send({ error: 'observations required' })
    const narrative = await composeNarrative(observations, insights || [], narrative_type || 'soap', patient_context)
    return narrative
  })

  app.post('/api/v1/practitioner/takeaways', async (request, reply) => {
    const { conversation_text, session_id, patient_hash } = request.body as any
    if (!conversation_text) return reply.status(400).send({ error: 'conversation_text required' })
    const userId = request.user!.userId
    const takeaways = await extractTakeaways({
      userId,
      sessionId: session_id || `manual_${Date.now()}`,
      conversationText: conversation_text,
      patientHash: patient_hash,
    })
    return { takeaways }
  })

  app.get('/api/v1/practitioner/takeaways', async (request) => {
    const { scope_kind, scope_ref } = request.query as any
    const userId = request.user!.userId
    const takeaways = await listTakeaways(userId, scope_kind, scope_ref)
    return { takeaways }
  })

  app.post('/api/v1/practitioner/takeaways/:id/acknowledge', async (request, reply) => {
    const { id } = request.params as any
    const { action } = request.body as any
    const userId = request.user!.userId
    const ok = await acknowledgeTakeaway(parseInt(id), userId, action || 'accept')
    if (!ok) return reply.status(404).send({ error: 'Takeaway not found' })
    return { ok: true }
  })
}
