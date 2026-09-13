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
import { listPendingSuggestions, resolveSuggestedReference } from '../shared/suggested-reference.service.js'
// #1014: 摘要登记为引用材料 → 使用反馈（referenced）。
import { recordMemoryUsage } from '../../memory/memory-usage-bus.js'
// #1017: 「固定为引用 / 取消引用」统一走 MemoryTierStore 留痕。
import { ReferenceTierStore } from '../../memory/memory-tier-store.js'

const log = makeLogger('references.router')

/** snapshot 上限（粘贴正文/摘要全文）— 防超大请求。 */
const MAX_CONTENT_CHARS = 200_000
const MAX_SESSION_ID = 200

function isCanonicalKind(v: string): v is ReferenceKind {
  return v === 'file' || v === 'kb_summary' || v === 'pasted_text'
}

export async function referencesRouter(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authGuard)

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
    Body: { kind?: string; content?: string; label?: string; source_ref?: string; source_patient_hash?: string }
  }>('/api/v1/sessions/:sessionId/references', async (request, reply) => {
    const userId = request.user!.userId
    const sessionId = String(request.params.sessionId || '').slice(0, MAX_SESSION_ID)
    if (!sessionId) return reply.status(400).send({ error: 'sessionId required' })
    const body = request.body || {}

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
