import { FastifyInstance } from 'fastify'
import { authGuard, adminGuard } from '../../common/auth.guard'
import { PrismaKnowledgeGapService, type GapSource } from './knowledge-gap.service'
import { getUserContext } from '../chat/user-context.js'
import { SidecarFeedbackService, type SidecarOutputType } from './sidecar-feedback.service.js'
import { isNodeSuperseded } from '../../memory/memory.types.js'
import { PrismaTelemetryService } from './telemetry.service.js'
import { deepseekChat, getApiKey , DEEPSEEK_CHAT_MODEL } from '../../common/llm.js'

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
      status: q.status || 'open',
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

  // Create a knowledge article directly (e.g. from a Sidecar-generated document)
  app.post('/api/v1/knowledge/articles', async (request, reply) => {
    const userId = request.user!.userId
    const body = request.body as any
    if (!body?.title || !body?.content) {
      return reply.status(400).send({ error: 'title and content required' })
    }

    const ctx = getUserContext(userId)
    const article = ctx.memory.addArticle({
      title: String(body.title),
      content: String(body.content),
      sourceFactStableIds: Array.isArray(body.sources) ? body.sources.map(String) : [],
      sourceDocuments: body.sourceId ? [String(body.sourceId)] : [],
    })

    await telemetry.record({
      userId,
      workspaceId: userId,
      category: 'kb_command',
      action: 'article_created',
      metadata: { articleId: article.stableId, source: 'sidecar' },
    }).catch(() => {})

    return {
      id: article.stableId,
      title: article.title,
      content: article.content,
      sources: article.sourceFacts.map(s => s.stableId),
      version: article.version,
      status: article.status,
      createdAt: article.createdAt,
      updatedAt: article.updatedAt,
    }
  })

  // List knowledge articles with stale/impact metadata
  app.get('/api/v1/knowledge/articles', async (request) => {
    const userId = request.user!.userId
    const ctx = getUserContext(userId)
    const articles = ctx.memory.graph.getCurrentNodesByType('article')
      .filter((n): n is import('../../memory/memory.types.js').ArticleNode => n.type === 'article')
      .map(a => serializeArticle(a, ctx.memory))
    return { articles }
  })

  // Get a single article with impact details
  app.get('/api/v1/knowledge/articles/:id', async (request, reply) => {
    const userId = request.user!.userId
    const { id } = request.params as { id: string }
    const ctx = getUserContext(userId)
    const article = ctx.memory.graph.getLatestByStableId(id)
    if (!article || article.type !== 'article' || isNodeSuperseded(article)) {
      return reply.status(404).send({ error: 'article not found' })
    }
    return serializeArticle(article as import('../../memory/memory.types.js').ArticleNode, ctx.memory)
  })

  // Regenerate a stale article from its current source facts
  app.post('/api/v1/knowledge/articles/:id/regenerate', async (request, reply) => {
    const userId = request.user!.userId
    const { id } = request.params as { id: string }
    const ctx = getUserContext(userId)
    const article = ctx.memory.graph.getLatestByStableId(id) as import('../../memory/memory.types.js').ArticleNode | undefined
    if (!article || article.type !== 'article' || isNodeSuperseded(article)) {
      return reply.status(404).send({ error: 'article not found' })
    }

    const regenerated = await regenerateArticleWithLlm(article, ctx.memory, userId)
    if (!regenerated.ok) {
      return reply.status(500).send({ error: regenerated.error })
    }

    await telemetry.record({
      userId,
      workspaceId: userId,
      category: 'kb_command',
      action: 'article_regenerated',
      metadata: { articleId: regenerated.value.stableId, previousVersion: article.id },
    }).catch(() => {})

    return serializeArticle(regenerated.value, ctx.memory)
  })

  // Manually edit an article
  app.put('/api/v1/knowledge/articles/:id', async (request, reply) => {
    const userId = request.user!.userId
    const { id } = request.params as { id: string }
    const body = request.body as any
    const ctx = getUserContext(userId)
    const edited = ctx.memory.editArticle(id, {
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
      metadata: { articleId: edited.value.stableId },
    }).catch(() => {})

    return serializeArticle(edited.value, ctx.memory)
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

function serializeArticle(article: import('../../memory/memory.types.js').ArticleNode, memory: import('../../memory/memory.service').MemoryService) {
  const impact = (article.staleBecause || []).map(factStableId => {
    const fact = memory.graph.getLatestByStableId(factStableId) as import('../../memory/memory.types.js').FactNode | undefined
    return {
      factId: factStableId,
      status: fact?.status || 'unknown',
      content: fact?.content || '',
      message: `依赖的 Fact ${factStableId} 已更新`,
    }
  })

  return {
    id: article.stableId,
    title: article.title,
    content: article.content,
    status: article.status,
    version: article.version,
    sources: article.sourceFacts.map(s => s.stableId),
    staleBecause: article.staleBecause || [],
    impact,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
  }
}

async function regenerateArticleWithLlm(
  article: import('../../memory/memory.types.js').ArticleNode,
  memory: import('../../memory/memory.service').MemoryService,
  userId: string,
): Promise<import('../../common/result').Result<import('../../memory/memory.types.js').ArticleNode>> {
  const sourceFacts = article.sourceFacts
    .map(s => memory.graph.getLatestByStableId(s.stableId))
    .filter((n): n is import('../../memory/memory.types.js').FactNode => n?.type === 'fact' && n.status !== 'superseded')

  let title = article.title
  let content = article.content

  if (sourceFacts.length > 0) {
    const factList = sourceFacts
      .map(f => `[importance=${f.importance ?? 3}] [${f.category}] ${f.content}`)
      .join('\n')
    const prompt = `You are synthesizing clinical findings for an oncology researcher.
Synthesize the following facts into a concise, clinically actionable knowledge article.
Keep it to 1-2 paragraphs and a short title.

Facts:
${factList}

Return ONLY JSON: { "title": "...", "content": "..." }`
    try {
      const raw = await deepseekChat(
        [{ role: 'user', content: prompt }],
        getApiKey(),
        {
          model: DEEPSEEK_CHAT_MODEL,
          maxTokens: 2048,
          telemetryContext: { userId, workspaceId: userId, action: 'article.regenerate' },
        },
      )
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        if (parsed.title) title = String(parsed.title)
        if (parsed.content) content = String(parsed.content)
      }
    } catch {
      // Fall back to keeping existing title/content but still bumping the version.
    }
  }

  const edited = memory.editArticle(article.stableId, { title, content }, 'system')
  return edited
}