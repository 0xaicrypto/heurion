/**
 * Knowledge summaries / gaps / telemetry HTTP surface.
 *
 * #687 双 router 边界:本文件 = 文章(生成/重生成/编辑)/gap 检测/遥测的
 * HTTP 面;knowledge-stores.router.ts = 记忆图谱(facts/nodes/versions)与
 * 工具商店的存储面。两者共享 authGuard 与 gapService,但端点前缀不同
 * (/api/v1/knowledge/* vs /api/v1/memory/* + tool-store),不构成重复路由。
 * LLM 生成在 summary-synthesis.service,展示序列化在 summary-view.service。
 */
import { FastifyInstance } from 'fastify'
import { authGuard, adminGuard } from '../../common/auth.guard'
import { PrismaKnowledgeGapService, type GapSource } from './knowledge-gap.service'
import { getUserContext } from '../shared/user-context.js'
import { SidecarFeedbackService, type SidecarOutputType } from './sidecar-feedback.service.js'
import { isNodeSuperseded } from '../../memory/memory.types.js'
import { PrismaTelemetryService } from './telemetry.service.js'
import type { PickerNode } from './knowledge-picker.service.js'
import { regenerateSummaryWithLlm } from './summary-synthesis.service.js'
import { serializeSummary } from './summary-view.service.js'

const gapService = new PrismaKnowledgeGapService()
const telemetry = new PrismaTelemetryService()

function parseQueryInt(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? parseInt(value, 10) : typeof value === 'number' ? value : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export async function knowledgeRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // List knowledge gaps for the current user's workspace (paginated + filterable)
  app.get('/api/v1/knowledge/gaps', async (request) => {
    const userId = request.user!.userId
    const q = request.query as any
    const result = await gapService.list({
      workspaceId: userId,
      // #742: default 'all' — previously defaulted to 'open', so answered/
      // ignored gaps were unreachable from the UI even though they render.
      status: q.status || 'all',
      source: q.source || 'all',
      q: q.q,
      page: parseQueryInt(q.page, 1),
      pageSize: parseQueryInt(q.pageSize, 50),
      sortBy: q.sortBy === 'updatedAt' ? 'updatedAt' : 'createdAt',
      sortOrder: q.sortOrder === 'asc' ? 'asc' : 'desc',
    })
    return result
  })

  // Knowledge gap dashboard stats
  app.get('/api/v1/knowledge/gaps/dashboard', async (request) => {
    const userId = request.user!.userId
    const stats = await gapService.getStats(userId)
    return stats
  })

  // Suggest an answer for a knowledge gap from existing facts/knowledge
  app.get('/api/v1/knowledge/gaps/:id/suggest', async (request, reply) => {
    const userId = request.user!.userId
    const { id } = request.params as { id: string }

    const gap = await gapService.getById(id)
    if (!gap) {
      return reply.status(404).send({ error: 'gap not found' })
    }
    if (gap.userId !== userId) {
      return reply.status(403).send({ error: 'forbidden' })
    }

    const ctx = getUserContext(userId)
    const suggestions = await gapService.suggestAnswer(id, ctx.facts.all(), ctx.knowledge.all())
    return { suggestions }
  })

  // Create a knowledge gap (user-initiated)
  app.post('/api/v1/knowledge/gaps', async (request, reply) => {
    const userId = request.user!.userId
    const body = request.body as any
    if (!body?.content) {
      return reply.status(400).send({ error: 'content required' })
    }

    const source = (body.source || 'user') as GapSource
    const gap = await gapService.create({
      userId,
      workspaceId: userId,
      content: body.content,
      source,
      sourceId: body.sourceId,
    })

    await telemetry.record({
      userId,
      workspaceId: userId,
      category: 'gap',
      action: 'created',
      metadata: { source, sourceId: body.sourceId },
    }).catch(() => {})

    return gap
  })

  // Answer a knowledge gap: mark as answered and save the answer as a fact
  app.post('/api/v1/knowledge/gaps/:id/answer', async (request, reply) => {
    const userId = request.user!.userId
    const { id } = request.params as { id: string }
    const body = request.body as any
    if (!body?.answer) {
      return reply.status(400).send({ error: 'answer required' })
    }

    const gap = await gapService.getById(id)
    if (!gap) {
      return reply.status(404).send({ error: 'gap not found' })
    }
    if (gap.userId !== userId) {
      return reply.status(403).send({ error: 'forbidden' })
    }

    const ctx = getUserContext(userId)
    const fact = ctx.memory.addFact({
      category: 'fact',
      importance: 4,
      content: body.answer,
      sourceType: 'doctor',
    }, 'user')
    // Best-effort link to a memory gap node (gap may only exist in Prisma).
    ctx.memory.answerGap(id, fact)

    const updated = await gapService.resolve(id, body.answer)
    if (!updated) {
      return reply.status(500).send({ error: 'failed to resolve gap' })
    }

    await telemetry.record({
      userId,
      workspaceId: userId,
      category: 'gap',
      action: 'answered',
      metadata: { gapId: id, factId: fact.stableId },
    }).catch(() => {})

    return {
      ...updated,
      answerId: fact.stableId,
      status: 'answered',
    }
  })


  // Resolve a knowledge gap without requiring an explicit answer (UI quick-resolve)
  app.post('/api/v1/knowledge/gaps/:id/resolve', async (request, reply) => {
    const userId = request.user!.userId
    const { id } = request.params as { id: string }

    const gap = await gapService.getById(id)
    if (!gap) {
      return reply.status(404).send({ error: 'gap not found' })
    }
    if (gap.userId !== userId) {
      return reply.status(403).send({ error: 'forbidden' })
    }

    const updated = await gapService.resolve(id, 'Resolved from knowledge base UI')
    if (!updated) {
      return reply.status(500).send({ error: 'failed to resolve gap' })
    }

    await telemetry.record({
      userId,
      workspaceId: userId,
      category: 'gap',
      action: 'resolved',
      metadata: { gapId: id },
    }).catch(() => {})

    return updated
  })

  // Ignore a knowledge gap
  app.post('/api/v1/knowledge/gaps/:id/ignore', async (request, reply) => {
    const userId = request.user!.userId
    const { id } = request.params as { id: string }

    const gap = await gapService.getById(id)
    if (!gap) {
      return reply.status(404).send({ error: 'gap not found' })
    }
    if (gap.userId !== userId) {
      return reply.status(403).send({ error: 'forbidden' })
    }

    const updated = await gapService.ignore(id)
    if (!updated) {
      return reply.status(500).send({ error: 'failed to ignore gap' })
    }

    await telemetry.record({
      userId,
      workspaceId: userId,
      category: 'gap',
      action: 'ignored',
      metadata: { gapId: id },
    }).catch(() => {})

    return updated
  })

  // Create a knowledge summary directly (e.g. from a Sidecar-generated document)
  app.post('/api/v1/knowledge/summaries', async (request, reply) => {
    const userId = request.user!.userId
    const body = request.body as any
    if (!body?.title || !body?.content) {
      return reply.status(400).send({ error: 'title and content required' })
    }

    const ctx = getUserContext(userId)
    const summary = ctx.memory.addSummary({
      title: String(body.title),
      content: String(body.content),
      sourceFactStableIds: Array.isArray(body.sources) ? body.sources.map(String) : [],
      sourceDocuments: body.sourceId ? [String(body.sourceId)] : [],
    })

    await telemetry.record({
      userId,
      workspaceId: userId,
      category: 'kb_command',
      action: 'summary_created',
      metadata: { summaryId: summary.stableId, source: 'sidecar' },
    }).catch(() => {})

    return {
      id: summary.stableId,
      title: summary.title,
      content: summary.content,
      sources: summary.sourceFacts.map(s => s.stableId),
      version: summary.version,
      status: summary.status,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
    }
  })

  // #620: 知识库选择器 — chat 从知识库显式添加文章到上下文.
  // #628: 除合成文章(summary)外,同时列出用户上传过的文件(document),
  // 否则上传的文件永远不会出现在选择器里(文章需 ≥3 条 7 天内确认事实才合成)。
  app.get('/api/v1/knowledge/picker', async (request) => {
    const userId = request.user!.userId
    const ctx = getUserContext(userId)
    const q = String((request.query as any)?.q || '').trim()
    // #633: 选择器改用统一检索(keyword + vector RRF) — 语义相近词可命中
    // (如搜"放疗抵抗"命中 ATR 论文);embedding 故障自动回落词法。
    const nodes = ctx.memory.graph
      .getCurrentNodesByType('summary')
      .concat(ctx.memory.graph.getCurrentNodesByType('document'))
    const { EmbeddingService } = await import('../../memory/embedding/embedding.service.js')
    const embedding = new EmbeddingService(userId)
    const { searchPickerItems } = await import('./knowledge-picker.service.js')
    const hits = await searchPickerItems(
      nodes.map((n): PickerNode => n.type === 'summary'
        ? {
            stableId: n.stableId, type: 'summary', title: n.title,
            content: String((n as import('../../memory/memory.types.js').SummaryNode).content || '').slice(0, 2000),
            updatedAt: n.updatedAt,
          }
        : {
            stableId: n.stableId, type: 'document',
            title: (n as import('../../memory/memory.types.js').DocumentNode).name,
            updatedAt: n.updatedAt,
          }),
      q,
      embedding,
    )
    const items = hits.map(({ node }): any => {
      if (node.type === 'summary') {
        return {
          id: node.stableId,
          kind: 'summary',
          title: node.title,
          summary: String(node.content || '').slice(0, 120),
          updatedAt: node.updatedAt,
        }
      }
      return {
        id: node.stableId,
        kind: 'document',
        title: node.title,
        summary: '📎 文件',
        updatedAt: node.updatedAt,
      }
    })
    return { summaries: items.map((a) => ({ id: a.id, title: a.title, summary: a.summary, kind: a.kind, updated_at: a.updatedAt })) }
  })

  // #816: facts→summary 覆盖率仪表盘(global + 患者 scope)
  app.get('/api/v1/knowledge/coverage', async (request) => {
    const userId = request.user!.userId
    const ctx = getUserContext(userId)
    const { buildCoverageDashboard } = await import('../../memory/coverage.js')
    return buildCoverageDashboard(userId, ctx.memory)
  })

  // List knowledge summaries with stale/impact metadata
  app.get('/api/v1/knowledge/summaries', async (request) => {
    const userId = request.user!.userId
    const ctx = getUserContext(userId)
    const summaries = ctx.memory.graph.getCurrentNodesByType('summary')
      .filter((n): n is import('../../memory/memory.types.js').SummaryNode => n.type === 'summary')
      .map(a => serializeSummary(a, ctx.memory))
    return { summaries }
  })

  // Get a single summary with impact details
  app.get('/api/v1/knowledge/summaries/:id', async (request, reply) => {
    const userId = request.user!.userId
    const { id } = request.params as { id: string }
    const ctx = getUserContext(userId)
    const summary = ctx.memory.graph.getLatestByStableId(id)
    if (!summary || summary.type !== 'summary' || isNodeSuperseded(summary)) {
      return reply.status(404).send({ error: 'summary not found' })
    }
    return serializeSummary(summary as import('../../memory/memory.types.js').SummaryNode, ctx.memory)
  })

  // Regenerate a stale summary from its current source facts
  app.post('/api/v1/knowledge/summaries/:id/regenerate', async (request, reply) => {
    const userId = request.user!.userId
    const { id } = request.params as { id: string }
    const ctx = getUserContext(userId)
    const summary = ctx.memory.graph.getLatestByStableId(id) as import('../../memory/memory.types.js').SummaryNode | undefined
    if (!summary || summary.type !== 'summary' || isNodeSuperseded(summary)) {
      return reply.status(404).send({ error: 'summary not found' })
    }

    const regenerated = await regenerateSummaryWithLlm(summary, ctx.memory, userId)
    if (!regenerated.ok) {
      return reply.status(500).send({ error: regenerated.error })
    }

    await telemetry.record({
      userId,
      workspaceId: userId,
      category: 'kb_command',
      action: 'summary_regenerated',
      metadata: { summaryId: regenerated.value.stableId, previousVersion: summary.id },
    }).catch(() => {})

    return serializeSummary(regenerated.value, ctx.memory)
  })

  // Manually edit an summary
  app.put('/api/v1/knowledge/summaries/:id', async (request, reply) => {
    const userId = request.user!.userId
    const { id } = request.params as { id: string }
    const body = request.body as any
    const ctx = getUserContext(userId)
    const edited = ctx.memory.editSummary(id, {
      title: body?.title,
      content: body?.content,
    }, 'user')
    if (!edited.ok) {
      return reply.status(404).send({ error: edited.error })
    }

    await telemetry.record({
      userId,
      workspaceId: userId,
      category: 'kb_command',
      action: 'article_edited',
      metadata: { summaryId: edited.value.stableId },
    }).catch(() => {})

    return serializeSummary(edited.value, ctx.memory)
  })

  // Sidecar output feedback: extract candidates and optionally save facts
  app.post('/api/v1/knowledge/sidecar/feedback', async (request, reply) => {
    const userId = request.user!.userId
    const body = request.body as any
    if (!body?.output || typeof body.output !== 'string') {
      return reply.status(400).send({ error: 'output required' })
    }

    const ctx = getUserContext(userId)
    const service = new SidecarFeedbackService(ctx.memory)
    const result = await service.process({
      userId,
      workspaceId: userId,
      output: body.output,
      outputType: (body.outputType || 'unknown') as SidecarOutputType,
      saveAll: body.saveAll === true,
      sourceId: body.sourceId,
    })

    await telemetry.record({
      userId,
      workspaceId: userId,
      category: 'kb_command',
      action: 'sidecar_feedback',
      metadata: {
        outputType: body.outputType,
        saveAll: body.saveAll === true,
        candidateCount: result.candidates.length,
        savedCount: result.saved.length,
      },
    }).catch(() => {})

    return result
  })

  // Telemetry dashboard
  app.get('/api/v1/knowledge/telemetry/dashboard', async (request) => {
    const userId = request.user!.userId
    const q = request.query as any
    return telemetry.dashboard(userId, q.from, q.to)
  })

  // Telemetry query (recent events)
  app.get('/api/v1/knowledge/telemetry', async (request) => {
    const userId = request.user!.userId
    const q = request.query as any
    return {
      events: await telemetry.query({
        workspaceId: userId,
        category: q.category,
        action: q.action,
        from: q.from,
        to: q.to,
        limit: parseQueryInt(q.limit, 100),
      }),
    }
  })

  // Global LLM cost dashboard — admin only
  app.get('/api/v1/admin/telemetry/llm-cost', { preHandler: adminGuard }, async (request) => {
    const q = request.query as any
    return telemetry.llmCostDashboard(q.from, q.to)
  })
}
