/**
 * #1006（SECOND_BRAIN Phase 1）— 会话级引用材料端点。
 *
 * `/api/v1/sessions/:sessionId/references`（GET/POST/DELETE）：写作
 * （'doc-<docId>'）与主 chat 共用的同一套引用能力；旧
 * `/api/v1/docs/:docId/references` 保留（写双写 + 旧响应形状），前端
 * 无需同批改造。取消引用只删 SessionReference，ReferenceItem 本体保留。
 */
import type { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import { makeLogger } from '../../common/logger.js'
import {
  addSessionReference,
  listSessionReferences,
  removeSessionReference,
  resolveFileSourceRef,
  normalizeLegacyRefType,
  type ReferenceKind,
} from '../../lib/reference-store.js'
import { classifyGuidelineBySummaryTitle } from '../shared/summary-lookup.js'
// #1009: 语义索引 + 对话中建议（pending 列表 / 接受或忽略）。
import { indexReferenceItem } from '../../memory/reference-embedding.js'
import { detectOpeningSuggestions, listPendingSuggestions, resolveSuggestedReference } from '../shared/suggested-reference.service.js'
// #1014: 摘要登记为引用材料 → 使用反馈（referenced）。
import { recordMemoryUsage } from '../../memory/memory-usage-bus.js'
// #1017: 「固定为引用 / 取消引用」统一走 MemoryTierStore 留痕。
import { ReferenceTierStore } from '../../memory/memory-tier-store.js'
// #1010: 引用材料池（选择器隐式排序）— 关键词重叠做"当前场景相关"。
import prisma from '../../common/prisma.js'
import { extractKeywords, overlapScore } from '../../retrieval/text-overlap.js'

const log = makeLogger('references.router')

/** snapshot 上限（粘贴正文/摘要全文）— 防超大请求。 */
const MAX_CONTENT_CHARS = 200_000
const MAX_SESSION_ID = 200

function isCanonicalKind(v: string): v is ReferenceKind {
  return v === 'file' || v === 'kb_summary' || v === 'pasted_text'
}

export async function referencesRouter(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authGuard)

  // #1010: 用户级引用材料池 — 供选择器做隐式排序（最近用过/用得最多/当前场景相关）。
  // 数据源 = ReferenceItem 本体 + MemoryUsageBus 聚合；不引入文件夹/标签。
  app.get('/api/v1/references', async (request) => {
    const userId = request.user!.userId
    const q = request.query as Record<string, string | undefined>
    const sort = q.sort === 'frequent' || q.sort === 'relevant' ? q.sort : 'recent'
    const context = String(q.context || '').slice(0, 4000)
    const parsedLimit = parseInt(String(q.limit || '20'), 10)
    const limit = Math.min(Math.max(Number.isFinite(parsedLimit) ? parsedLimit : 20, 1), 50)

    const items = await prisma.referenceItem.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    if (items.length === 0) return { items: [] }
    const ids = items.map((i) => i.id)
    const usedActions = ['referenced', 'accepted']

    const [counts, recent] = await Promise.all([
      prisma.memoryUsageEvent.groupBy({
        by: ['unitId'],
        where: { userId, unitType: 'reference', unitId: { in: ids }, action: { in: usedActions } },
        _count: { _all: true },
      }),
      // 近 500 条足够覆盖池内活跃条目的"最近使用会话"（池上限 200）。
      prisma.memoryUsageEvent.findMany({
        where: { userId, unitType: 'reference', unitId: { in: ids }, action: { in: usedActions } },
        orderBy: { at: 'desc' },
        select: { unitId: true, sessionId: true, at: true },
        take: 500,
      }),
    ])
    const countMap = new Map(counts.map((c) => [c.unitId, c._count._all]))
    const lastMap = new Map<string, { at: string; sessionId: string | null }>()
    for (const e of recent) {
      if (!lastMap.has(e.unitId)) lastMap.set(e.unitId, { at: e.at, sessionId: e.sessionId })
    }
    const sessionIds = [...new Set([...lastMap.values()].map((v) => v.sessionId).filter((v): v is string => !!v))]
    const sessions = sessionIds.length
      ? await prisma.session.findMany({ where: { id: { in: sessionIds } }, select: { id: true, title: true } })
      : []
    const titleMap = new Map(sessions.map((s) => [s.id, s.title]))

    const keywords = sort === 'relevant' && context ? extractKeywords(context) : []
    const scored = items.map((item) => {
      const last = lastMap.get(item.id)
      const usage = {
        session_count: countMap.get(item.id) ?? 0,
        last_used_at: last?.at ?? null,
        last_session_id: last?.sessionId ?? null,
        last_session_title: last?.sessionId ? (titleMap.get(last.sessionId) ?? null) : null,
      }
      const score = keywords.length ? overlapScore(keywords, `${item.label} ${item.snapshot}`) : 0
      return { item, usage, score }
    })
    const byRecency = (a: typeof scored[number], b: typeof scored[number]) =>
      (b.usage.last_used_at || '').localeCompare(a.usage.last_used_at || '')
      || b.item.createdAt.localeCompare(a.item.createdAt)
    if (sort === 'frequent') {
      scored.sort((a, b) => b.usage.session_count - a.usage.session_count || byRecency(a, b))
    } else if (sort === 'relevant' && keywords.length) {
      scored.sort((a, b) => b.score - a.score || byRecency(a, b))
    } else {
      scored.sort(byRecency)
    }

    return {
      items: scored.slice(0, limit).map(({ item, usage, score }) => ({
        reference_id: item.id,
        kind: item.kind,
        label: item.label,
        content: item.snapshot.slice(0, 200),
        source_ref: item.sourceRef,
        created_at: item.createdAt,
        usage,
        score,
      })),
    }
  })

  app.get<{ Params: { sessionId: string } }>('/api/v1/sessions/:sessionId/references', async (request) => {
    const userId = request.user!.userId
    const sessionId = String(request.params.sessionId || '').slice(0, MAX_SESSION_ID)
    if (!sessionId) return { references: [] }
    const rows = await listSessionReferences(userId, sessionId)
    return {
      references: rows.map((r) => ({
        reference_id: r.referenceId,
        session_reference_id: r.sessionReferenceId,
        kind: r.item.kind,
        content: r.item.snapshot,
        label: r.item.label,
        source_ref: r.item.sourceRef,
        source: r.source,
        created_at: r.addedAt,
      })),
    }
  })

  app.post<{
    Params: { sessionId: string }
    Body: { kind?: string; content?: string; label?: string; source_ref?: string; source_patient_hash?: string; reference_id?: string }
  }>('/api/v1/sessions/:sessionId/references', async (request, reply) => {
    const userId = request.user!.userId
    const sessionId = String(request.params.sessionId || '').slice(0, MAX_SESSION_ID)
    if (!sessionId) return reply.status(400).send({ error: 'sessionId required' })
    const body = request.body || {}

    // #1010: 从引用池复用时按既有 item id 精确挂载（pasted_text 正文不进请求体，
    // 也避免按截断内容重新哈希造成重复条目）。
    const existingRefId = String(body.reference_id || '').trim()
    if (existingRefId) {
      const item = await prisma.referenceItem.findFirst({ where: { id: existingRefId, userId } })
      if (!item) return reply.status(404).send({ error: 'reference item not found' })
      const itemKind = normalizeLegacyRefType(item.kind)
      const mounted = await addSessionReference({
        userId,
        sessionId,
        item: { userId, kind: itemKind, sourceRef: item.sourceRef, label: item.label, snapshot: item.snapshot },
        source: 'manual',
      })
      recordMemoryUsage({ userId, unitType: 'reference', unitId: mounted.referenceId, action: 'referenced', sessionId })
      void indexReferenceItem({ id: mounted.referenceId, userId, kind: itemKind, sourceRef: item.sourceRef, snapshot: item.snapshot, label: item.label })
      await new ReferenceTierStore(userId)
        .promote(mounted.referenceId, 'reference', 'reference', `mounted to session ${sessionId}`)
        .catch((err) => log.warn('reference tier trace failed (pool mount)', { err: String(err).slice(0, 120) }))
      log.info('session reference mounted from pool', { userId, sessionId, kind: itemKind, referenceId: mounted.referenceId })
      return {
        reference_id: mounted.referenceId,
        kind: itemKind,
        content: item.snapshot,
        label: item.label,
        source_ref: item.sourceRef,
        source: mounted.source,
        created_at: mounted.addedAt,
      }
    }

    const rawKind = String(body.kind || '').trim()
    const label = String(body.label || '').trim()
    let kind: ReferenceKind
    let sourceRef: string | null = null
    if (rawKind === 'guideline') {
      // 旧前端语义：知识库摘要/临床指南粘贴混用 — 以标题命中 Summary 归类。
      const classified = await classifyGuidelineBySummaryTitle(userId, label)
      kind = classified.kind
      sourceRef = classified.sourceRef
    } else if (rawKind) {
      kind = normalizeLegacyRefType(rawKind)
    } else {
      kind = 'pasted_text'
    }
    if (!isCanonicalKind(kind)) return reply.status(400).send({ error: `invalid kind: ${rawKind}` })

    const content = String(body.content || '')
    if (content.length > MAX_CONTENT_CHARS) return reply.status(413).send({ error: `content too large (max ${MAX_CONTENT_CHARS} chars)` })
    if (kind === 'pasted_text' && !content.trim()) return reply.status(400).send({ error: 'content required for pasted_text' })

    const snapshot = kind === 'file' ? (label || content).trim() : content
    if (kind === 'file' && !snapshot) return reply.status(400).send({ error: 'label (file name) required for file kind' })

    if (kind === 'file' && !sourceRef) {
      sourceRef = await resolveFileSourceRef(userId, body.source_patient_hash, snapshot)
    }
    if (kind === 'kb_summary' && !sourceRef && typeof body.source_ref === 'string' && body.source_ref.trim()) {
      sourceRef = body.source_ref.trim()
    }

    const mounted = await addSessionReference({
      userId,
      sessionId,
      item: {
        userId, kind, sourceRef,
        label: label || snapshot.slice(0, 120),
        snapshot,
      },
      source: 'manual',
    })
    if (kind === 'kb_summary' && sourceRef) {
      recordMemoryUsage({ userId, unitType: 'summary', unitId: sourceRef, action: 'referenced', sessionId })
    }
    // #1010: 引用池使用留痕（全部 kind）— 选择器隐式排序/使用痕迹的数据源。
    recordMemoryUsage({ userId, unitType: 'reference', unitId: mounted.referenceId, action: 'referenced', sessionId })
    // #1009: 引用正文（file 懒解析）送语义索引 — fire-and-forget。
    void indexReferenceItem({ id: mounted.referenceId, userId, kind, sourceRef, snapshot, label: label || snapshot.slice(0, 120) })
    // #1017: 固定为引用的层级留痕（reference 层 promote；实际挂载已落库）。
    await new ReferenceTierStore(userId)
      .promote(mounted.referenceId, 'reference', 'reference', `mounted to session ${sessionId}`)
      .catch((err) => log.warn('reference tier trace failed (best-effort)', { err: String(err).slice(0, 120) }))
    log.info('session reference mounted', { userId, sessionId, kind, referenceId: mounted.referenceId })
    return {
      reference_id: mounted.referenceId,
      kind,
      content: snapshot,
      label: label || snapshot.slice(0, 120),
      source_ref: sourceRef,
      source: mounted.source,
      created_at: mounted.addedAt,
    }
  })

  // #1009: 待确认建议列表（跟随回复展示）。
  app.get<{ Params: { sessionId: string } }>('/api/v1/sessions/:sessionId/references/suggestions', async (request) => {
    const userId = request.user!.userId
    const sessionId = String(request.params.sessionId || '').slice(0, MAX_SESSION_ID)
    if (!sessionId) return { suggestions: [] }
    return { suggestions: await listPendingSuggestions(userId, sessionId) }
  })

  // #1008: 开局检测 — 打开会话时用标题/近期消息关键词命中未引用材料。
  app.post<{ Params: { sessionId: string }; Body: { context?: string } }>(
    '/api/v1/sessions/:sessionId/references/suggestions/scan',
    async (request) => {
      const userId = request.user!.userId
      const sessionId = String(request.params.sessionId || '').slice(0, MAX_SESSION_ID)
      if (!sessionId) return { suggestions: [] }
      await detectOpeningSuggestions({ userId, sessionId, context: String(request.body?.context || '') })
      return { suggestions: await listPendingSuggestions(userId, sessionId) }
    },
  )

  // #1009: 接受（生成正式引用，source='suggestion_accepted'）/ 忽略。
  app.post<{ Params: { sessionId: string; suggestionId: string }; Body: { accept?: boolean } }>(
    '/api/v1/sessions/:sessionId/references/suggestions/:suggestionId/resolve',
    async (request, reply) => {
      const userId = request.user!.userId
      const sessionId = String(request.params.sessionId || '').slice(0, MAX_SESSION_ID)
      const suggestionId = String(request.params.suggestionId || '')
      if (!sessionId || !suggestionId) return reply.status(400).send({ error: 'sessionId and suggestionId required' })
      const result = await resolveSuggestedReference(userId, sessionId, suggestionId, request.body?.accept !== false)
      if (!result.ok) return reply.status(404).send({ error: result.error })
      return { ok: true, reference_id: result.referenceId }
    },
  )

  app.delete<{ Params: { sessionId: string; referenceId: string } }>(
    '/api/v1/sessions/:sessionId/references/:referenceId',
    async (request, reply) => {
      const userId = request.user!.userId
      const sessionId = String(request.params.sessionId || '').slice(0, MAX_SESSION_ID)
      const referenceId = String(request.params.referenceId || '')
      if (!sessionId || !referenceId) return reply.status(400).send({ error: 'sessionId and referenceId required' })
      const mounted = (await listSessionReferences(userId, sessionId)).some((r) => r.referenceId === referenceId)
      if (!mounted) return reply.status(404).send({ error: 'Reference not mounted in this session' })
      // 只删会话挂载 — item 本体保留（设计红线：取消引用 ≠ 删除内容）。
      await removeSessionReference(userId, sessionId, referenceId)
      // #1017: 取消引用的层级留痕（reference 层 demote）。
      await new ReferenceTierStore(userId)
        .demote(referenceId, 'reference', 'reference', `unmounted from session ${sessionId}`)
        .catch((err) => log.warn('reference tier trace failed (best-effort)', { err: String(err).slice(0, 120) }))
      return { ok: true }
    },
  )
}
