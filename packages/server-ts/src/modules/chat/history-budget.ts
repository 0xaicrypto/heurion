/**
 * #544 — compaction scheduling, extracted from chat-handler.ts.
 *
 * Owns the "when to compact" decision and the fire-and-forget trigger:
 *   - main trigger: real user/assistant turns exceeded the window or some
 *     were omitted (opencode-style delayed-sync semantics — a later turn
 *     awaits an in-flight compaction before replying);
 *   - trim trigger: the knowledge injection pushed history over the total
 *     budget, so the trimmed history is compacted asynchronously.
 * Also: session-memory summary surfacing (compaction_summary event + log).
 */
import prisma from '../../common/prisma'
import { getUserContext } from '../shared/user-context.js'
import { MAX_HISTORY_TOKENS } from '../shared/chat-context.js'
import { CONTEXT_CONFIG } from '../../common/context-config.js'
import { buildHistoryMessages } from '../../retrieval/context-compressor.js'
import { ensureSessionCompaction, getInFlightCompaction, type CompactionOutcome } from '../../memory/compaction/index.js'

export interface CompactionTriggers {
  userId: string
  sid: string
  patientHash?: string | null
  ctx: Awaited<ReturnType<typeof getUserContext>>
  send: (chunk: any) => void
  /** Newest-first user/assistant history (raw event log rows). */
  history: any[]
  /** Newest-first history messages under the token budget. */
  historyMessages: Array<{ role: string; content: string }>
  omittedTurns: number
  historyTurns: number
  maxHistoryTokens: number
}

/**
 * #display: 压缩结果对用户可见的通知文本。返回 null = 不打扰(noop)。
 * 此前压缩完成后,摘要只在 LLM 成功且 episodes 命中时才展示 — LLM 失败
 * 时压缩"无声消失",用户完全不知道发生了什么。现在 done/failed 都有
 * 如实通知,noop 保持沉默。
 */
export function buildCompactionNotice(outcome: CompactionOutcome, fallbackSummary: string): string | null {
  if (outcome.kind === 'noop') return null
  if (outcome.kind === 'failed') {
    return `⚠️ 已压缩检测：历史超窗（${outcome.events} 条消息），本轮摘要生成失败 — 下一回合自动重试，对话不受影响。`
  }
  const events = outcome.events
  const summaryText = outcome.summary?.trim() || fallbackSummary.trim()
  if (summaryText) {
    return `📋 已压缩前序对话（${events} 条消息），上下文预算已恢复。\n要点：\n${summaryText}`
  }
  return `📋 已压缩前序对话（${events} 条消息），上下文预算已恢复。（本轮未生成摘要文本）`
}

/** Build the compaction-completed reporter: reloads the cursor, recomputes
 *  the restored budget and surfaces the session summary (if any). */
function buildCompactionCompletedReporter(t: CompactionTriggers) {
  const { userId, sid, ctx, send, historyTurns, maxHistoryTokens } = t
  return async (outcome: CompactionOutcome) => {
    // #598: 压缩已写入新 compactedUpto — 必须重新读取,否则用本轮
    // 压缩前的旧 cursor 计算,预算仍显示压缩前的高水位(如 70%)。
    const latest = await loadCompactedUpto(userId, sid)
    const restored = ctx.eventLog
      .query({ sessionId: sid, limit: historyTurns * 2 * 8 })
      .filter((e: any) => e.idx > latest && (e.eventType === 'user_message' || e.eventType === 'assistant_response'))
      .reverse()
    const { tokens: restoredTokens } = buildHistoryMessages(restored, {
      maxTokens: maxHistoryTokens,
      maxTurns: historyTurns,
    })
    send({ type: 'compaction_completed', history_tokens: restoredTokens, history_budget: maxHistoryTokens, history_turns: historyTurns })

    // #612/#display: 压缩结果作为聊天记录展示 — 通知文本(event log 落库,
    // 刷新后历史可见)+ SSE 给当前窗口。摘要来源: 本次 episodeUpdate →
    // kbCompaction 行 → episodes 全量会话摘要(向后兼容)。
    try {
      const episodeSummary = ctx.episodes.all().find((e: any) => e.sessionId === sid)?.summary || ''
      const content = buildCompactionNotice(outcome, episodeSummary)
      if (!content) return
      // fallback 摘要来自 episodes(含更早压缩的合并文本) — 用行内最新
      // 摘要更精确,但 noop/一致性优先,这里保持简单。
      ctx.eventLog.append({
        timestamp: Date.now() / 1000,
        eventType: 'assistant_response',
        content,
        metadata: { compactionSummary: true },
        agentId: userId,
        sessionId: sid,
      })
      send({ type: 'compaction_summary', text: content })
    } catch { /* best-effort: 摘要展示失败不影响对话 */ }
  }
}

function fireCompaction(t: CompactionTriggers, completed: (outcome: CompactionOutcome) => void): void {
  const oldestRetainedIdx = (t.history[t.historyMessages.length - 1] as any)?.idx ?? 0
  ensureSessionCompaction(
    {
      userId: t.userId,
      eventLog: t.ctx.eventLog,
      facts: t.ctx.facts,
      episodes: t.ctx.episodes,
      skills: t.ctx.skills,
      knowledge: t.ctx.knowledge,
      memory: t.ctx.memory,
    },
    t.sid,
    oldestRetainedIdx,
    t.patientHash || undefined,
  )
    .then(completed)
    .catch(() => {})
}

/**
 * R2 — main trigger with delayed-sync semantics: the triggering turn fires
 * compaction async (no reply latency); any LATER turn that arrives while it
 * is still running awaits it before replying. Both cases surface
 * compaction_started/compaction_completed to the UI.
 */
export async function maybeTriggerCompaction(t: CompactionTriggers): Promise<void> {
  const sendCompactionCompleted = buildCompactionCompletedReporter(t)
  const inFlightCompaction = getInFlightCompaction(t.userId, t.sid)
  // #compaction-fix: trigger on REAL message turns (history is now
  // filtered to user/assistant), not raw event count.
  const shouldTrigger = !t.sid.startsWith('doc-') && (t.omittedTurns > 0 || t.history.length >= t.historyTurns * 2)
  if (shouldTrigger && t.historyMessages.length > 0) {
    t.send({ type: 'compaction_started' })
    fireCompaction(t, sendCompactionCompleted)
  } else if (inFlightCompaction) {
    // A compaction from an earlier turn is still running — wait for it
    // (and its anchored summary) before replying.
    t.send({ type: 'compaction_started' })
    const outcome = await inFlightCompaction
    sendCompactionCompleted(outcome)
  }
}

/** #621: 知识库注入后超预算 — 历史被裁剪时同步触发压缩(async),
 *  压缩后历史从新 cursor 开始,后续轮次预算回落到低位。 */
export function triggerCompactionAfterTrim(t: CompactionTriggers): void {
  t.send({ type: 'compaction_started' })
  fireCompaction(t, () => t.send({ type: 'compaction_completed' }))
}
/** Load the session's latest compaction boundary (for the sidecar/plugin path). */
export async function loadCompactedUpto(userId: string, sid: string): Promise<number> {
  try {
    const compacted = await (prisma as any).kbCompaction.findFirst({
      where: { userId, sessionId: sid },
      orderBy: { coveredUptoIdx: 'desc' },
    })
    return compacted?.coveredUptoIdx ?? 0
  } catch {
    return 0
  }
}

/** Build conversation history (newest-first) under a token/turn budget. */
export async function loadHistoryBudget(
  ctx: Awaited<ReturnType<typeof getUserContext>>,
  sid: string,
  userId: string,
): Promise<{
  history: any[]
  historyMessages: Array<{ role: 'user' | 'assistant'; content: string }>
  omittedTurns: number
  historyTokens: number
  maxHistoryTokens: number
  historyTurns: number
  compactedUpto: number
}> {
  // #writing-cost: 写作(doc-*)会话历史预算降额 — 润色聚焦当前文档,
  // 老对话价值低;防"文档+参考+历史"冲顶总预算导致 TTFB 长/成本高。
  const isDocSession = sid.startsWith('doc-')
  const maxHistoryTokens = isDocSession ? CONTEXT_CONFIG.docHistoryTokens : MAX_HISTORY_TOKENS
  const historyTurns = parseInt(process.env.HISTORY_TURNS || '20', 10)
  let compactedUpto = 0
  try {
    const lastCompaction = await (prisma as any).kbCompaction.findFirst({
      where: { userId, sessionId: sid },
      orderBy: { coveredUptoIdx: 'desc' },
    })
    compactedUpto = lastCompaction?.coveredUptoIdx ?? 0
  } catch {
    // kbCompaction may not exist yet
  }
  // Only user/assistant messages count as turns — tool calls, tool results
  // and context events are transport noise and must NOT trigger compaction
  // (#compaction-fix: a 3-turn chat with heavy tool use filled the 40-event
  // window and compacted repeatedly while the token budget was nearly empty).
  const history = ctx.eventLog
    .query({ sessionId: sid, limit: historyTurns * 2 * 8 })
    .filter((e: any) => e.idx > compactedUpto && (e.eventType === 'user_message' || e.eventType === 'assistant_response'))
    .reverse()
  const { messages: historyMessages, omittedTurns, tokens: historyTokens } = buildHistoryMessages(history, {
    maxTokens: maxHistoryTokens,
    maxTurns: historyTurns,
  })
  return { history, historyMessages, omittedTurns, historyTokens, maxHistoryTokens, historyTurns, compactedUpto }
}

/** Session row upsert — writing (doc-*) sessions and legacy (global-*)
 *  sessions never get a Session row. */
export async function upsertSessionRow(userId: string, sid: string, title: string): Promise<void> {
  if (sid.startsWith('doc-') || sid.startsWith('global-')) return
  await prisma.session.upsert({
    where: { id: sid },
    update: { lastMessageAt: new Date().toISOString(), messageCount: { increment: 1 } },
    create: { id: sid, userId, title, createdAt: new Date().toISOString() },
  })
}

/** #598: stream a compaction summary that happened on an earlier turn but
 *  was never shown to the current client (event log compaction + episode). */
export async function streamUnshownCompaction(
  userId: string,
  ctx: Awaited<ReturnType<typeof getUserContext>>,
  sid: string,
  io: { send: (chunk: any) => void },
): Promise<void> {
  try {
    const allEvents = ctx.eventLog.query({ sessionId: sid })
    const lastReply = allEvents
      .filter((e: any) => e.eventType === 'assistant_response')
      .sort((a: any, b: any) => b.idx - a.idx)[0]
    const lastCompaction = allEvents
      .filter((e: any) => e.eventType === 'evolution' && String(e.content || '').includes('自动压缩'))
      .sort((a: any, b: any) => b.idx - a.idx)[0]
    if (lastCompaction && (!lastReply || lastCompaction.idx > lastReply.idx)) {
      // #display: 摘要来源三连 — episodes 全量 → 最新 kbCompaction 行
      // (runner 现在落本次 episodeUpdate) → 无摘要则不打扰。
      let summaryText = ctx.episodes.all().find((e: any) => e.sessionId === sid)?.summary || ''
      if (!summaryText.trim()) {
        try {
          const row = await (prisma as any).kbCompaction.findFirst({
            where: { userId, sessionId: sid },
            orderBy: { coveredUptoIdx: 'desc' },
          })
          summaryText = String(row?.summary || '')
        } catch { /* fallback best-effort */ }
      }
      if (summaryText.trim()) {
        const header = `🧠 会话历史已压缩，上下文预算已恢复\n\n${summaryText}`
        for (const piece of header.match(/.{1,60}/gs) || []) {
          io.send({ type: 'compaction_chunk', text: piece })
        }
        io.send({ type: 'compaction_completed' })
      }
    }
  } catch {
    // compaction summary streaming is best-effort
  }
}
