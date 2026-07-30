import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import { getUserContext } from '../chat/user-context.js'
import prisma from '../../common/prisma.js'
import { getUserTools, getEnabledTools, deleteUserTool } from '../../evolution/cascade-gaps.js'
import { PrismaKnowledgeGapService } from '../knowledge/knowledge-gap.service.js'
import { generateReportPdf } from '../report/report-pdf.service.js'
import type { MemoryNode } from '../../memory/memory.types.js'

const gapService = new PrismaKnowledgeGapService()

export async function stubRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // ── Archive patient ──
  app.post('/api/v1/dicom/patients/:hash/archive', async (request) => {
    return { archived: true, patient_hash: (request.params as any).hash }
  })

  // ── Report download ──
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

  // ── Memory medications ──
  app.get('/api/v1/memory/patient/:patientHash/medications', async () => {
    return { medications: [] }
  })

  // ── Schedule ──
  app.get('/api/v1/schedule/list', async (request) => {
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
  app.get('/api/v1/chat/files', async (request: any) => {
    const userId = request.user!.userId
    const files = await (prisma as any).fileIndex.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }).catch(() => [])
    return { files: files.map((f: any) => ({
      file_id: f.fileId, name: f.name, mime_type: f.mimeType,
      size_bytes: f.sizeBytes, patient_hash: f.patientHash,
      created_at: f.createdAt,
    })) }
  })

  // ── Email (stub) ──
  app.get('/api/v1/email/transport', async () => {
    return { transports: [] }
  })
  app.post('/api/v1/email/send', async (request: any) => {
    return { ok: true, message_id: `msg_${Date.now()}` }
  })

  // ── Billing (stub) ──
  app.post('/api/v1/billing/checkout', async () => {
    return { url: '', session_id: '' }
  })
  app.post('/api/v1/billing/portal', async () => {
    return { url: '' }
  })
  app.post('/api/v1/billing/webhook', async (request: any, reply: any) => {
    return reply.status(200).send({ received: true })
  })
  app.get('/api/v1/billing/subscription', async () => {
    return { tier: 'beta', status: 'active', current_period_end: null }
  })

  // ── Feedback ──
  app.post('/feedback', async () => {
    return { ok: true }
  })

  // ── Memory versioning & impact ──
  app.get('/api/v1/memory/nodes/:id/versions', async (request: any) => {
    const ctx = getUserContext(request.user!.userId)
    const versions = ctx.memory.graph.getVersions(request.params.id as string)
    return { versions }
  })
  app.get('/api/v1/memory/articles/:id/impact', async (request: any) => {
    const ctx = getUserContext(request.user!.userId)
    const article = ctx.memory.graph.getLatestByStableId(request.params.id as string) as any
    if (!article || article.type !== 'article') return { error: 'Not found' }
    return { impact: article.impact || [] }
  })

  // ── Memory graph (Cytoscape) ──
  app.get('/api/v1/memory/graph', async (request: any) => {
    const ctx = getUserContext(request.user!.userId)
    const q = request.query as any
    const includeSuperseded = q.include_superseded === 'true' || q.include_superseded === true
    const patientHash = q.patient_hash as string | undefined

    let nodes = includeSuperseded
      ? Array.from(ctx.memory.graph.getNodesByType('fact'))
          .concat(Array.from(ctx.memory.graph.getNodesByType('article')))
          .concat(Array.from(ctx.memory.graph.getNodesByType('gap')))
          .concat(Array.from(ctx.memory.graph.getNodesByType('document')))
          .concat(Array.from(ctx.memory.graph.getNodesByType('entity')))
          .concat(Array.from(ctx.memory.graph.getNodesByType('skill')))
      : ctx.memory.graph.getCurrentNodes()

    const seen = new Map<string, MemoryNode>()
    for (const n of nodes) {
      const existing = seen.get(n.stableId)
      if (!existing || (existing.status === 'superseded' && n.status !== 'superseded')) {
        seen.set(n.stableId, n)
      }
    }
    nodes = Array.from(seen.values())

    if (patientHash) {
      const relatedStableIds = new Set<string>()
      for (const n of nodes) {
        if ((n as any).patientHash === patientHash) relatedStableIds.add(n.stableId)
      }
      const allRelations = ctx.memory.graph.relationCount > 0 ? (ctx.memory.graph as any).relations as Array<{ sourceId: string; targetId: string; relation: string; id?: string }> : []
      for (const r of allRelations) {
        const sourceStable = ctx.memory.graph.getNode(r.sourceId)?.stableId
        const targetStable = ctx.memory.graph.getNode(r.targetId)?.stableId
        if (!sourceStable || !targetStable) continue
        if (relatedStableIds.has(sourceStable)) relatedStableIds.add(targetStable)
        if (relatedStableIds.has(targetStable)) relatedStableIds.add(sourceStable)
      }
      nodes = nodes.filter(n => relatedStableIds.has(n.stableId))
    }

    const nodeStableIds = new Set(nodes.map(n => n.stableId))
    const allRelations = ctx.memory.graph.relationCount > 0 ? (ctx.memory.graph as any).relations as Array<{ id?: string; sourceId: string; targetId: string; relation: string; createdAt?: number }> : []
    const visibleRelations = allRelations
      .map(r => {
        const sourceStable = ctx.memory.graph.getNode(r.sourceId)?.stableId
        const targetStable = ctx.memory.graph.getNode(r.targetId)?.stableId
        if (!sourceStable || !targetStable) return null
        if (!nodeStableIds.has(sourceStable) || !nodeStableIds.has(targetStable)) return null
        return { ...r, sourceId: sourceStable, targetId: targetStable }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)

    return {
      nodes: nodes.map(n => ({ ...n })),
      relations: visibleRelations,
    }
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
      const sid = String(id)
      if (ctx.memory.deleteFact(sid).ok) {
        deleted++
      } else if (!sid.startsWith('fact_') && ctx.facts.remove(sid)) {
        deleted++
      }
    }
    ctx.facts.commit()
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

  // ── Knowledge & Facts API (legacy file-backed stores) ──
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
    const id = request.params.id as string
    let fact = ctx.memory.editFact(id, {
      content: patch.content,
      category: patch.category,
      importance: patch.importance,
      sourceType: patch.sourceType,
    })
    if (!fact && !id.startsWith('fact_')) {
      const changed = ctx.facts.updateWhere(f => f.id === id, {
        content: patch.content,
        category: patch.category,
        importance: patch.importance,
        sourceType: patch.sourceType,
      })
      if (changed > 0) {
        fact = ctx.facts.all().find(f => f.id === id) as any
      }
    }
    if (!fact) return { error: 'Not found' }
    return { fact }
  })
  app.delete('/api/v1/facts/:id', async (request: any) => {
    const ctx = getUserContext(request.user!.userId)
    const id = request.params.id as string
    let ok = ctx.memory.deleteFact(id).ok
    if (!ok && !id.startsWith('fact_')) {
      ok = ctx.facts.remove(id)
      if (ok) ctx.facts.commit()
    }
    return { deleted: ok }
  })

  // ── Report generation ──
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
