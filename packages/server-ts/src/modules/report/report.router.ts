/**
 * #440 — Report PDF endpoints. Extracted from the misnamed stubs.router.ts.
 *
 * #中-10: POST persists the rendered PDF (owner-scoped by userId+patient hash);
 * GET replays the stored artifact and 404s when nothing was ever generated.
 * The old GET fabricated an empty-findings "Report generated on demand." PDF
 * for any hash — clinically indistinguishable from a clean report.
 */
import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import prisma from '../../common/prisma.js'
import { generateReportPdf } from './report-pdf.service.js'

export async function reportRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  app.get('/api/v1/report/pdf/:hash', async (request, reply) => {
    const { hash } = request.params as any
    const userId = request.user!.userId
    const stored = await prisma.clinicalReport
      .findUnique({ where: { userId_patientHash: { userId, patientHash: String(hash) } } })
      .catch(() => null)
    if (!stored) {
      reply.header('Content-Type', 'application/json')
      return reply.status(404).send({ error: 'Report not found, generate it first via POST /api/v1/report/pdf' })
    }
    reply.header('Content-Type', 'application/pdf')
    reply.header('Content-Disposition', `attachment; filename="report-${hash}.pdf"`)
    return Buffer.from(stored.pdf)
  })

  app.post('/api/v1/report/pdf', async (request: any) => {
    const body = (request.body || {}) as any
    const userId = request.user?.userId || ''
    const patientHash = String(body.patient_hash || '')
    // #中-10: 前端提交的是 clinical_info 文本（旧路由丢掉了它，生成的报告
    // 永远没有临床信息）— 归一为一条 findings，同时保留结构化 findings。
    const findings = Array.isArray(body.findings) && body.findings.length > 0
      ? body.findings
      : (typeof body.clinical_info === 'string' && body.clinical_info.trim()
        ? [{ name: 'Clinical information', description: String(body.clinical_info) }]
        : [])
    const pdf = await generateReportPdf({
      patient_hash: patientHash,
      userId,
      findings,
      impression: body.impression,
      recommendation: body.recommendation,
      locale: body.locale,
    })
    const now = new Date().toISOString()
    await prisma.clinicalReport.upsert({
      where: { userId_patientHash: { userId, patientHash } },
      update: { pdf, updatedAt: now },
      create: { userId, patientHash, pdf, createdAt: now, updatedAt: now },
    })
    return {
      path: `/api/v1/report/pdf/${patientHash || 'unknown'}`,
      bytes: pdf.length,
      created_at: Math.floor(Date.now() / 1000),
      patient_hash: patientHash,
    }
  })
}
