import { resolveTierModel } from '../../common/llm-gateway.js'
import { makeLogger } from '../../common/logger.js'
import { deepseekChat, getApiKey} from '../../common/llm.js'
import prisma from '../../common/prisma.js'
import { MemoryGraphGateway } from '../memory-gateway.js'
import {
  buildContextBlock,
  parseExtractionResult,
  type CompactionCtx,
  type ExtractedFact,
} from './budget.js'
import { factExtractionPrompt, EXTRACTION_RULES } from '../prompts.js'
import { parseLlmJson } from '../../common/llm-json.js'

const slog = makeLogger('documents.extract')

/**
 * #353: compaction/extraction runner — Tier 2 (compaction-time batch) and
 * Tier 3 (session-close flush) both funnel through here. In-flight state
 * lives in state.ts; prompt/context shaping in budget.ts.
 */
const log = makeLogger('compaction')
export async function extractAndProposeFacts(
  ctx: CompactionCtx,
  patientHash: string | undefined,
  conversation: string,
  opts: { sessionId: string; reason: string },
): Promise<ExtractedFact[]> {
  if (!conversation.trim()) return []
  const apiKey = getApiKey()
  const contextBlock = buildContextBlock(ctx, patientHash, opts.sessionId, conversation)
  // 13.4F: dynamic quality guidance from recent acceptance rates.
  let qualityGuidance = ''
  try {
    const { getCategoryQuality, buildQualityGuidance } = await import('../extraction-quality.js')
    qualityGuidance = buildQualityGuidance(await getCategoryQuality(ctx.userId))
  } catch {
    // quality stats are best-effort
  }
  const prompt = factExtractionPrompt({ text: conversation, contextBlock, qualityGuidance })

  const chatOpts = {
    model: resolveTierModel('fast'),
    maxTokens: 2048,
    telemetryContext: { userId: ctx.userId, workspaceId: ctx.userId, action: 'chat.extract_facts' },
  } as const

  let result = await deepseekChat([{ role: 'user', content: prompt }], apiKey, chatOpts)
  let parsed: Array<Record<string, any>> | null = parseExtractionResult(result)
  if (parsed === null) {
    // #182: retry once with a correction hint — a failed parse must NOT
    // silently drop the segment.
    log.warn('unparseable LLM output, retrying with correction')
    const retryPrompt = `${prompt}\n\n你的上一次输出无法解析为 JSON 数组。请只返回合法的 JSON 数组，不要包含任何其他文本或解释。`
    result = await deepseekChat([{ role: 'user', content: retryPrompt }], apiKey, chatOpts)
    parsed = parseExtractionResult(result)
  }
  if (parsed === null) {
    // Still failing: throw so the caller does NOT advance the cursor — the
    // segment will be retried on the next extraction pass.
    throw new Error(`Extraction output unparseable (2 attempts): ${result.slice(0, 120)}`)
  }
  const extracted: ExtractedFact[] = []
  const gateway = ctx.memory
    ? new MemoryGraphGateway(ctx.userId, ctx.memory, ctx.episodes)
    : null
  for (const f of parsed) {
    if (!f.category || !f.content) continue
    const fact: ExtractedFact = {
      category: f.category,
      importance: Math.min(5, Math.max(1, f.importance || 3)),
      content: f.content,
      sourceType: f.sourceType || 'general',
      patientHash: f.sourceType === 'patient' ? (patientHash || undefined) : undefined,
      conflictsWith: Array.isArray(f.conflictsWith) ? f.conflictsWith.map(String) : undefined,
    }
    extracted.push(fact)
    if (gateway) {
      try {
        await gateway.propose({
          scopeType: patientHash ? 'patient' : 'global',
          patientHash: fact.patientHash || patientHash,
          kind: 'fact',
          content: fact.content,
          importance: fact.importance,
          confidence: 'medium',
          reason: `${opts.reason} (${fact.category}, source: ${fact.sourceType})`,
          category: fact.category,
          // #836-followup: 会话溯源 — 审批列表与 summary 合成需回溯来源会话。
          sourceRange: `session:${opts.sessionId}`,
          conflictsWith: fact.conflictsWith?.map(stableId => ({ stableId, content: '' })),
        })
      } catch (err) {
        log.warn('proposal write skipped', { reason: (err as Error).message.slice(0, 120) })
      }
    }
  }
  ctx.eventLog.append({
    timestamp: Date.now() / 1000,
    eventType: 'evolution',
    content: `🧠 Proposed ${extracted.length} new facts for review (${opts.reason})`,
    metadata: { factCount: extracted.length, reason: opts.reason, categories: [...new Set(extracted.map(f => f.category))] },
    agentId: ctx.userId, sessionId: opts.sessionId,
  })
  return extracted
}
/**
 * #display: 压缩结果对象 — 让调用方(完成 reporter)能对用户如实展示
 * 「压缩了什么/多少条」,而不是失败后静默蒸发。
 *   - noop: 无可压缩段(游标已覆盖/事件过少)
 *   - done: 摘要+事实提取成功,游标已推进
 *   - failed: LLM 摘要失败,游标不推进(下轮重试同段)
 */
export interface CompactionOutcome {
  kind: 'noop' | 'done' | 'failed'
  /** 本次合并进 Session Memory 的摘要文本(done 且 LLM 产出时非空)。 */
  summary: string
  /** 本次覆盖的事件区间 [prevCoveredIdx, coveredIdx]。 */
  prevCoveredIdx: number
  coveredIdx: number
  /** 被压缩的 user/assistant 消息条数。 */
  events: number
}

export async function runSessionCompaction(
  ctx: CompactionCtx,
  sessionId: string,
  firstRetainedIdx: number,
  patientHash?: string,
): Promise<CompactionOutcome> {
  // S2: kbCompaction keeps ONLY the per-session compaction cursor (no
  // summary content) — anchored summaries now live in the Session Memory
  // (episodes). Works for sessions without a Session row (default global).
  // #display: summary 列现在落**本次** episodeUpdate — 纯展示用途
  // (注入仍走 episodes),用户可见"这次压缩了什么"。
  const last = await (prisma as any).kbCompaction.findFirst({
    where: { userId: ctx.userId, sessionId },
    orderBy: { coveredUptoIdx: 'desc' },
  })
  const covered = last?.coveredUptoIdx ?? 0
  const target = firstRetainedIdx - 1
  if (target <= covered) return { kind: 'noop', summary: '', prevCoveredIdx: covered, coveredIdx: covered, events: 0 }

  const events = ctx.eventLog
    .query({ sessionId, afterIdx: covered })
    .filter((e: any) => e.idx <= target && (e.eventType === 'user_message' || e.eventType === 'assistant_response'))
  if (events.length < 4) return { kind: 'noop', summary: '', prevCoveredIdx: covered, coveredIdx: target, events: events.length }

  const conversation = events
    .map((e: any) => `${e.eventType === 'user_message' ? 'USER' : 'AI'}: ${String(e.content || '').slice(0, 500)}`)
    .join('\n')

  const apiKey = getApiKey()
  const contextBlock = buildContextBlock(ctx, patientHash, sessionId, conversation)
  const prompt = `You are a clinical conversation compressor. Compact the OLD conversation segment below into three outputs:

1. anchoredSummary — a structured JSON object (Chinese) that preserves continuity for later turns:
   { "patient": "patient state", "decisions": ["conclusions reached"], "treatment": ["medications/regimens"], "vitals": ["key values"], "pending": ["open tasks"], "questions": ["unanswered questions"] }
   Include only what still matters; omit resolved items.

2. facts — a JSON array per the extraction rules:
${EXTRACTION_RULES}

3. episodeUpdate — an updated session-summary text (Chinese, bullet points, ≤300 tokens): merge the segment into the existing summary, keep still-true details, drop outdated ones.

Return ONLY JSON:
{"anchoredSummary": {...}, "facts": [{"content": "...", "category": "...", "importance": 1-5, "sourceType": "patient|doctor|research", "conflictsWith": ["stableId of a same-scope confirmed fact, only when contradicting"]}], "episodeUpdate": "..."}
${contextBlock}
Old conversation segment:
${conversation}

[JSON]:`

  const result = await deepseekChat(
    [{ role: 'user', content: prompt }],
    apiKey,
    {
      model: resolveTierModel('fast'),
      maxTokens: 4000,
      telemetryContext: { userId: ctx.userId, workspaceId: ctx.userId, action: 'chat.compact_segment' },
    },
  )
  // #694: parseLlmJson 收编 — 此前正则截 {...} 再裸 JSON.parse，围栏/
  // 闲话变体直接丢失整段压缩结果。
  const parsed = parseLlmJson<{
    anchoredSummary?: Record<string, any>
    facts?: Array<Record<string, any>>
    episodeUpdate?: string
  }>(result)
  // #display: 解析失败 — 游标不推进(下轮重试同段),但结果如实上抛,
  // reporter 对用户可见;此前静默 return,压缩发生了用户却永远看不到。
  if (!parsed) {
    log.warn('compaction: LLM extraction unparseable — cursor NOT advanced (will retry)', { sessionId, covered, target })
    return { kind: 'failed', summary: '', prevCoveredIdx: covered, coveredIdx: target, events: events.length }
  }

  const now = new Date().toISOString()

  // 1) Batch fact proposals → pending review queue.
  let proposed = 0
  if (Array.isArray(parsed.facts)) {
    const gateway = ctx.memory
      ? new MemoryGraphGateway(ctx.userId, ctx.memory, ctx.episodes)
      : null
    for (const f of parsed.facts) {
      if (!f.category || !f.content) continue
      if (gateway) {
        try {
          await gateway.propose({
            scopeType: patientHash ? 'patient' : 'global',
            patientHash: f.sourceType === 'patient' ? (patientHash || undefined) : undefined,
            kind: 'fact',
            content: f.content,
            importance: Math.min(5, Math.max(1, f.importance || 3)),
            confidence: 'medium',
            reason: `Compaction extraction (${f.category}, source: ${f.sourceType || 'general'})`,
            category: f.category,
            // #836-followup: 会话溯源 — 同上,审批收件箱按会话聚合展示。
            sourceRange: `session:${sessionId}`,
            conflictsWith: Array.isArray(f.conflictsWith) ? f.conflictsWith.map((sid: any) => ({ stableId: String(sid), content: '' })) : undefined,
          })
          proposed++
        } catch (err) {
          log.warn('fact proposal skipped', { reason: (err as Error).message.slice(0, 100) })
        }
      }
    }
  }

  // 2) Episode summary merge (K3).
  if (parsed.episodeUpdate && parsed.episodeUpdate.trim()) {
    ctx.episodes.upsert(sessionId, parsed.episodeUpdate.trim(), Math.floor(target / 2))
    ctx.episodes.commit()
  }

  // 3) S2: no anchored-summary store — the episodeUpdate already merged the
  // segment into the Session Memory (episodes). The cursor row advances so
  // segments are never re-compacted; #display: summary 列落本次
  // episodeUpdate(纯展示,注入仍走 episodes)。
  await (prisma as any).kbCompaction.create({
    data: {
      userId: ctx.userId,
      sessionId,
      summary: (parsed.episodeUpdate || '').trim(),
      coveredUptoIdx: target,
      tokenSavings: null,
      createdAt: now,
    },
  })
  // S3: the compacted segment is fully processed — advance the extraction
  // cursor so the session-close flush never re-extracts it.
  try {
    const { advanceExtractedUptoIdx } = await import('../extraction-cursor.js')
    const scopeKey: { userId: string; scopeType: 'patient' | 'global'; patientHash?: string; sessionId?: string } = {
      userId: ctx.userId,
      scopeType: patientHash ? 'patient' : 'global',
      patientHash,
      sessionId,
    }
    await advanceExtractedUptoIdx(scopeKey, target)
  } catch (err) {
    log.warn('cursor advance skipped', { reason: (err as Error).message.slice(0, 100) })
  }

  ctx.eventLog.append({
    timestamp: Date.now() / 1000,
    eventType: 'evolution',
    content: `🧠 自动压缩 ${Math.floor(events.length / 2)} 轮对话 → Session Memory 更新${proposed > 0 ? ` + ${proposed} 条事实待审核` : ''}`,
    metadata: { compactedTurns: Math.floor(events.length / 2), proposedFacts: proposed, coveredUptoIdx: target },
    agentId: ctx.userId, sessionId,
  })
  log.info('session compacted', { sessionId, compactedUptoIdx: target, proposedFacts: proposed, events: events.length })
  return {
    kind: 'done',
    summary: (parsed.episodeUpdate || '').trim(),
    prevCoveredIdx: covered,
    coveredIdx: target,
    events: events.length,
  }
}

/**
 * S3 — the single extraction entry point. Processes an uncovered event
 * segment: batch extraction → pending, K3 Session Memory update, cursor
 * advance. Tier 2 (compaction) and Tier 3 (session close) both funnel here.
 */
export async function extractSegment(
  ctx: CompactionCtx,
  sessionId: string,
  patientHash: string | undefined,
  fromIdx: number,
  toIdx: number,
): Promise<number> {
  const events = ctx.eventLog
    .query({ sessionId, afterIdx: fromIdx })
    .filter((e: any) => e.idx <= toIdx && (e.eventType === 'user_message' || e.eventType === 'assistant_response'))
  if (events.length < 2) return 0

  const conversation = events
    .map((e: any) => `${e.eventType === 'user_message' ? 'USER' : 'AI'}: ${String(e.content || '').slice(0, 500)}`)
    .join('\n')

  // 1) Batch extraction → pending review queue.
  const extracted = await extractAndProposeFacts(ctx, patientHash, conversation, {
    sessionId,
    reason: 'segment extraction',
  })

  // 2) K3: update the Session Memory (episodes).
  try {
    const { updateEpisodeSummary } = await import('../knowledge-synthesis.js')
    await updateEpisodeSummary({
      userId: ctx.userId,
      sessionId,
      patientHash,
      episodes: ctx.episodes,
      incrementalText: conversation,
      turnCount: toIdx,
    })
  } catch (err) {
    slog.info('[EXTRACT] Session Memory update skipped:', (err as Error).message.slice(0, 120))
  }

  // 3) Advance the cursor to the LAST EVENT THIS SEGMENT actually covered —
  // never to the global count, or events of OTHER sessions sitting between
  // fromIdx and toIdx would be permanently skipped (cross-session safety).
  try {
    const { advanceExtractedUptoIdx } = await import('../extraction-cursor.js')
    const scopeKey: { userId: string; scopeType: 'patient' | 'global'; patientHash?: string; sessionId?: string } = {
      userId: ctx.userId,
      scopeType: patientHash ? 'patient' : 'global',
      patientHash,
      sessionId,
    }
    const coveredMax = events.length > 0 ? Math.max(...events.map((e: any) => e.idx)) : fromIdx
    await advanceExtractedUptoIdx(scopeKey, coveredMax)
  } catch (err) {
    slog.info('[EXTRACT] Cursor advance skipped:', (err as Error).message)
  }

  return extracted.length
}

/**
 * Tier 3 — session-close flush. Extracts any conversation segment not yet
 * covered by the incremental cursor OR a prior compaction. Called when a
 * session is closed, so short sessions never lose memory.
 */
export async function flushUnextracted(
  ctx: CompactionCtx,
  sessionId: string,
  patientHash?: string,
): Promise<number> {
  const { getExtractedUptoIdx } = await import('../extraction-cursor.js')
  const scopeKey: { userId: string; scopeType: 'patient' | 'global'; patientHash?: string; sessionId?: string } = {
    userId: ctx.userId,
    scopeType: patientHash ? 'patient' : 'global',
    patientHash,
    sessionId,
  }
  const cursor = await getExtractedUptoIdx(scopeKey)
  const last = await (prisma as any).kbCompaction.findFirst({
    where: { userId: ctx.userId, sessionId },
    orderBy: { coveredUptoIdx: 'desc' },
  })
  const fromIdx = Math.max(cursor, last?.coveredUptoIdx ?? 0)
  try {
    return await extractSegment(ctx, sessionId, patientHash, fromIdx, ctx.eventLog.count())
  } catch (err) {
    slog.info('[FLUSH] Extraction skipped:', (err as Error).message.slice(0, 120))
    return 0
  }
}