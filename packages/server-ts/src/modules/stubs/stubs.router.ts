import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import { getUserContext } from '../chat/user-context.js'
import { getUserTools, getEnabledTools, deleteUserTool } from '../../evolution/cascade-gaps.js'
import { PrismaKnowledgeGapService } from '../knowledge/knowledge-gap.service.js'
import type { MemoryNode } from '../../memory/memory.types.js'

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
    const id = request.params.id as string
    let fact = ctx.memory.editFact(id, {
      content: patch.content,
      category: patch.category,
      importance: patch.importance,
      sourceType: patch.sourceType,
    })
    // Fallback for legacy facts that were created before MemoryService (raw id).
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
    // Fallback for legacy facts with raw ids.
    if (!ok && !id.startsWith('fact_')) {
      ok = ctx.facts.remove(id)
      if (ok) ctx.facts.commit()
    }
    return { deleted: ok }
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

    // Deduplicate by stableId (prefer current/stale over superseded)
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
      // Expand one hop via relations (relations are stored by node id, not stableId)
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
    // Build relation list from all relations, mapping node ids to stableIds and filtering to visible nodes
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
  app.post('/api/v1/report/pdf', async (request: any) => {
    return { path: '/tmp/report.pdf', bytes: 0, created_at: Math.floor(Date.now()/1000), patient_hash: request.body?.patient_hash || '' }
  })
}
