/**
 * #1009（SECOND_BRAIN Phase 3）— 对话中建议（语义版）。
 *
 * 复用 K6 的判定族（`detectQuestionShaped` + 缺口升级条件）反向运行：
 * 用户消息是问题形态、且被某条「当前会话未引用」的 ReferenceItem 语义
 * 覆盖时，生成一条 SuggestedReference（pending，跟随回复展示 — 前端 #1012）。
 *
 * 纪律（设计原则 4）：建议永不自动变成正式引用；用户接受才产生
 * SessionReference(source='suggestion_accepted')，忽略只置 dismissed。
 * 命中/接受/忽略事件写入 MemoryUsageBus（#1014）。
 */
import prisma from '../../common/prisma.js'
import { makeLogger } from '../../common/logger.js'
import { memoryGranularity } from '../../memory/granularity-controller.js'
import { detectQuestionShaped } from '../knowledge/gap-detect.js'
import { EmbeddingService } from '../../memory/embedding/embedding.service.js'
import { recordMemoryUsage } from '../../memory/memory-usage-bus.js'
import { addSessionReference, listSessionReferences, type ReferenceItemInput } from '../../lib/reference-store.js'
import { ReferenceTierStore } from '../../memory/memory-tier-store.js'

const log = makeLogger('chat.suggested-reference')

/** 语义命中阈值 — 低于该分不算"内容相关"（宁缺勿扰）。 */
const SUGGEST_MIN_SCORE = 0.5

export interface SuggestedReferenceRow {
  id: string
  sessionId: string
  referenceId: string
  reason: string
  suggestedAt: string
  status: string
  reference: { id: string; kind: string; label: string; snapshot: string; sourceRef: string | null }
}

export async function listPendingSuggestions(userId: string, sessionId: string): Promise<SuggestedReferenceRow[]> {
  const rows = await prisma.suggestedReference.findMany({
    where: { userId, sessionId, status: 'pending' },
    orderBy: { suggestedAt: 'desc' },
    take: 5,
  })
  const out: SuggestedReferenceRow[] = []
  for (const r of rows) {
    const item = await prisma.referenceItem.findUnique({ where: { id: r.referenceId } }).catch(() => null)
    if (!item) continue
    out.push({
      id: r.id, sessionId: r.sessionId, referenceId: r.referenceId, reason: r.reason,
      suggestedAt: r.suggestedAt, status: r.status,
      reference: { id: item.id, kind: item.kind, label: item.label, snapshot: item.snapshot.slice(0, 400), sourceRef: item.sourceRef },
    })
  }
  return out
}

export interface DetectSuggestedInput {
  userId: string
  sessionId: string
  /** 患者会话范围 — 语义检索按此做患者隔离（#1009 隐私边界）。 */
  patientHash?: string | null
  message: string
  /** 测试注入的 embedder。 */
  embedFn?: (texts: string[]) => Promise<number[][]>
}

/**
 * 对话中建议检测：问题形态 + 语义命中未引用材料 → 创建 pending 建议。
 * 返回建议行（无命中/不满足条件 → null）。post-turn best-effort 调用。
 */
export async function detectSuggestedReference(input: DetectSuggestedInput): Promise<{ suggestionId: string; referenceId: string } | null> {
  try {
    const questionShaped = detectQuestionShaped(input.message)
    if (!memoryGranularity.shouldPromote({
      kind: 'gap',
      covered: false,
      questionShaped,
      messageLength: input.message.length,
    })) return null

    const embedding = new EmbeddingService(input.userId, undefined, input.embedFn)
    const hits = await embedding.retrieve(input.message, { patientHash: input.patientHash ?? undefined }, { topK: 10, minScore: SUGGEST_MIN_SCORE })
    const refHits = hits.filter((h) => h.type === 'reference')
    if (refHits.length === 0) return null

    // 已挂载 / 已建议（pending 或 dismissed）的材料不再打扰。
    const mounted = new Set((await listSessionReferences(input.userId, input.sessionId)).map((r) => r.referenceId))
    const surfaced = new Set(
      (await prisma.suggestedReference.findMany({
        where: { userId: input.userId, sessionId: input.sessionId, status: { in: ['pending', 'dismissed'] } },
        select: { referenceId: true },
      })).map((r) => r.referenceId),
    )
    const pick = refHits.find((h) => {
      const itemId = h.stableId.split('::')[0]
      return itemId && !mounted.has(itemId) && !surfaced.has(itemId)
    })
    if (!pick) return null
    const referenceId = pick.stableId.split('::')[0]

    const row = await prisma.suggestedReference.create({
      data: {
        sessionId: input.sessionId,
        userId: input.userId,
        referenceId,
        reason: '对话内容命中未引用材料',
        suggestedAt: new Date().toISOString(),
        status: 'pending',
      },
    })
    recordMemoryUsage({ userId: input.userId, unitType: 'reference', unitId: referenceId, action: 'suggested', sessionId: input.sessionId })
    return { suggestionId: row.id, referenceId }
  } catch (err) {
    log.warn('suggested reference detection skipped (best-effort)', { err: String(err).slice(0, 120) })
    return null
  }
}

/**
 * 处理建议：accept=true → 正式引用（source='suggestion_accepted'）+ 层级
 * 留痕；false → 仅置 dismissed。两种情况都写使用反馈。
 */
export async function resolveSuggestedReference(
  userId: string,
  sessionId: string,
  suggestionId: string,
  accept: boolean,
): Promise<{ ok: true; referenceId: string } | { ok: false; error: string }> {
  const row = await prisma.suggestedReference.findFirst({ where: { id: suggestionId, userId, sessionId } }).catch(() => null)
  if (!row) return { ok: false, error: 'Suggestion not found' }
  if (row.status !== 'pending') return { ok: false, error: `Suggestion already ${row.status}` }
  const resolvedAt = new Date().toISOString()
  await prisma.suggestedReference.update({ where: { id: row.id }, data: { status: accept ? 'accepted' : 'dismissed', resolvedAt } })

  if (!accept) {
    recordMemoryUsage({ userId, unitType: 'reference', unitId: row.referenceId, action: 'dismissed', sessionId })
    return { ok: true, referenceId: row.referenceId }
  }

  const item = await prisma.referenceItem.findUnique({ where: { id: row.referenceId } }).catch(() => null)
  if (!item) return { ok: false, error: 'Reference item no longer exists' }
  const itemInput: ReferenceItemInput = {
    userId,
    kind: (item.kind as ReferenceItemInput['kind']) || 'pasted_text',
    sourceRef: item.sourceRef,
    label: item.label,
    snapshot: item.snapshot,
  }
  await addSessionReference({ userId, sessionId, item: itemInput, source: 'suggestion_accepted' })
  recordMemoryUsage({ userId, unitType: 'reference', unitId: row.referenceId, action: 'accepted', sessionId })
  await new ReferenceTierStore(userId)
    .promote(row.referenceId, 'reference', 'reference', `suggestion accepted in session ${sessionId}`)
    .catch(() => { /* best-effort 留痕 */ })
  return { ok: true, referenceId: row.referenceId }
}
