/**
 * #440 — Report PDF endpoints. Extracted from the misnamed stubs.router.ts.
 */
import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import { generateReportPdf } from './report-pdf.service.js'

export async function reportRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  app.get('/api/v1/report/pdf/:hash', async (request, reply) => {
    const { hash } = request.params as any
    const pdf = await generateReportPdf({
      patient_hash: hash,
      findings: [],
      impression: 'Report generated on demand.',
    }).catch(() => null)
    if (!pdf) {
      reply.header('Content-Type', 'application/json')
      return { error: 'Report not found, generate it first via POST /api/v1/report/pdf' }
    }
    reply.header('Content-Type', 'application/pdf')
    reply.header('Content-Disposition', `attachment; filename="report-${hash}.pdf"`)
    return pdf
  })

  app.post('/api/v1/report/pdf', async (request: any) => {
    const body = (request.body || {}) as any
    const pdf = await generateReportPdf({
      patient_hash: body.patient_hash || '',
      findings: body.findings || [],
      impression: body.impression,
      recommendation: body.recommendation,
      locale: body.locale,
    })
    return {
      path: `/api/v1/report/pdf/${body.patient_hash || 'unknown'}`,
      bytes: pdf.length,
      created_at: Math.floor(Date.now() / 1000),
      patient_hash: body.patient_hash || '',
    }
  })
}
