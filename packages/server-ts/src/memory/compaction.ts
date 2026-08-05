import { EventLog } from '../core/event-log'
import { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../evolution/stores'
import type { MemoryService } from './memory.service.js'
import { deepseekChat, getApiKey } from '../common/llm.js'
import prisma from '../common/prisma.js'
import { MemoryGraphGateway } from './memory-gateway.js'

/**
 * R2 — anchored compaction (BRAIN2_MEMORY_LIFECYCLE §4.3, issue #99).
 *
 * When a long session overflows the context budget, the dropped segment is
 * compacted ONCE into:
 *   1. an anchored summary (persisted → injected verbatim into later turns),
 *   2. batch fact proposals (pending review queue),
 *   3. an episode-summary update (K3 merge).
 *
 * Tier-2 of the three-tier extraction strategy:
 *   Tier 1 — signal-driven incremental extraction (K1/K2, strong signals only)
 *   Tier 2 — compaction-time batch extraction (this module)
 *   Tier 3 — session-close flush (flushUnextracted)
 */

export interface CompactionCtx {
  userId: string
  eventLog: EventLog
  facts: FactsStore
  episodes: EpisodesStore
  skills: SkillsStore
  knowledge: KnowledgeStore
  memory?: MemoryService
}

export interface ExtractedFact {
  content: string
  category: string
  importance: number
  sourceType: string
  patientHash?: string
  conflictsWith?: string[]
}

const EXTRACTION_RULES = `Rules:
1. AGGREGATE: merge related information about the same subject into ONE consolidated fact (e.g. symptoms+course → one disease-course fact; related exam values → one finding fact). Do not split a single topic into multiple fragments.
2. LIMIT: output at most 5 facts — the most important only.
3. IMPORTANCE GATE: only facts that affect future decisions (diagnosis, treatment, monitoring, patient safety). Omit marginal details.
4. SELF-CONTAINED: include subject (patient/doctor), time or trend, and concrete values.
   GOOD: "患者 ZQ 发热持续3周伴胸痛咳嗽，亚急性病程（7月末起）"
   BAD: "针对发热+胸痛需考虑肺部感染"
5. Exclude: conversational filler ("用户想学习", "谢谢"), generic advice ("需要做检查") unless it is a concrete conclusion for this patient, system state ("名册为空"), general knowledge.
6. CONFLICT: if new information contradicts an existing confirmed fact listed in the context (same subject, opposing or updated conclusion — e.g. allergy vs no-allergy, dose/plan change), set "conflictsWith": [the stableId of the conflicting fact]. Facts of OTHER patients are never conflicts — only facts tagged with the current scope.
   GOOD: {"content": "患者当前可用青霉素（既往过敏记录有误）", "conflictsWith": ["fact_xxx"]}
   BAD: flagging a different patient's fact as a conflict.`

function buildContextBlock(ctx: CompactionCtx, patientHash: string | undefined, sessionId: string, conversation: string): string {
  // §5.7: facts carry scope identity — only same-scope facts (this patient
  // or user-level global facts) are injected for dedup/conflict judgement.
  // Other patients' facts are NEVER injected (cross-patient ≠ contradiction).
  const kw = conversation.toLowerCase().split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(w => w.length > 3)
  const existingFacts = ctx.facts.all()
  const relatedFacts = existingFacts
    .filter(f => {
      if (f.patientHash) return f.patientHash === patientHash
      return true
    })
    .map(f => ({ f, score: kw.some(w => f.content.toLowerCase().includes(w)) ? 1 : 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(x => x.f)
  const episode = ctx.episodes.all().find(e => e.sessionId === sessionId)
  const contextLines: string[] = []
  if (patientHash) {
    contextLines.push(`Current patient: ${patientHash}`)
    contextLines.push('Facts about this patient should use sourceType: "patient" and include the patientHash.')
  }
  if (episode) {
    contextLines.push(`Session summary so far: ${episode.summary}`)
  }
  if (relatedFacts.length > 0) {
    contextLines.push('Existing confirmed facts in the SAME scope (use these for dedup AND conflict judgement — never flag a different patient\'s fact):')
    relatedFacts.forEach(f => {
      const tag = f.patientHash ? f.patientHash : 'user-level'
      contextLines.push(`- [${f.sourceType || 'general'}] [${tag}] (${f.id}) ${f.content}`)
    })
  }
  return contextLines.length > 0 ? `\n${contextLines.join('\n')}\n` : ''
}

/**
 * Shared extraction call (Tier 1 incremental and Tier 3 close-flush both use
 * this). AI extraction always lands in the pending review queue
 * (BRAIN2_MEMORY_LIFECYCLE §5.2 — no direct write path).
 */
export async function extractAndProposeFacts(
  ctx: CompactionCtx,
  patientHash: string | undefined,
  conversation: string,
  opts: { sessionId: string; reason: string },
): Promise<ExtractedFact[]> {
  if (!conversation.trim()) return []
  const apiKey = getApiKey()
  const contextBlock = buildContextBlock(ctx, patientHash, opts.sessionId, conversation)
  const prompt = `You are a clinical memory extractor. From the conversation below, extract ONLY facts worth persisting for future reference.

${EXTRACTION_RULES}

Return ONLY a JSON array:
[{"content": "consolidated fact", "category": "diagnosis|symptom|exam|medication|allergy|constraint|preference|plan", "importance": 1-5, "sourceType": "patient|doctor|research", "conflictsWith": ["stableId of a same-scope confirmed fact, only when contradicting"]}]

Importance: 5 = changes treatment/diagnosis; 4 = important clinical fact; 3 = general; 1-2 = marginal (omit).
${contextBlock}
Conversation:
${conversation}

[JSON array]:`

  const result = await deepseekChat(
    [{ role: 'user', content: prompt }],
    apiKey,
    {
      model: 'deepseek-chat',
      maxTokens: 2048,
      telemetryContext: { userId: ctx.userId, workspaceId: ctx.userId, action: 'chat.extract_facts' },
    },
  )
  const jsonMatch = result.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []

  const parsed = JSON.parse(jsonMatch[0]) as Array<Record<string, any>>
  const extracted: ExtractedFact[] = []
  const gateway = ctx.memory
    ? new MemoryGraphGateway(ctx.userId, ctx.memory, ctx.facts, ctx.episodes, ctx.skills, ctx.knowledge)
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
          conflictsWith: fact.conflictsWith?.map(stableId => ({ stableId, content: '' })),
        })
      } catch (err) {
        console.log('[EVOLVE] Proposal write skipped:', (err as Error).message.slice(0, 120))
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

// Per-session in-flight guard: compaction is an async side-effect of a turn,
// never re-entrant, and fires at most once per covered segment.
const inFlight = new Map<string, Promise<void>>()

/**
 * Returns the in-flight compaction promise for a session, or null when none
 * is running. Used for opencode-style delayed-sync: a turn that arrives
 * while the previous compaction is still running awaits it before replying,
 * so the anchored summary is always injectable.
 */
export function getInFlightCompaction(userId: string, sessionId: string): Promise<void> | null {
  return inFlight.get(`${userId}:${sessionId}`) ?? null
}

/**
 * R2 — entry point called from the chat router when the session budget
 * overflows (omitted turns) or the turn window is full. Compacts the dropped
 * segment [coveredUptoIdx, firstRetainedIdx) if it contains enough content.
 */
export function ensureSessionCompaction(
  ctx: CompactionCtx,
  sessionId: string,
  firstRetainedIdx: number,
  patientHash?: string,
): Promise<void> {
  const key = `${ctx.userId}:${sessionId}`
  if (inFlight.has(key)) return inFlight.get(key)!
  const p = runSessionCompaction(ctx, sessionId, firstRetainedIdx, patientHash)
    .catch(err => console.log('[COMPACT] failed:', (err as Error).message.slice(0, 120)))
    .finally(() => inFlight.delete(key))
  inFlight.set(key, p)
  return p
}

async function runSessionCompaction(
  ctx: CompactionCtx,
  sessionId: string,
  firstRetainedIdx: number,
  patientHash?: string,
): Promise<void> {
  // S2: kbCompaction keeps ONLY the per-session compaction cursor (no
  // summary content) — anchored summaries now live in the Session Memory
  // (episodes). Works for sessions without a Session row (default global).
  const last = await (prisma as any).kbCompaction.findFirst({
    where: { userId: ctx.userId, sessionId },
    orderBy: { coveredUptoIdx: 'desc' },
  })
  const covered = last?.coveredUptoIdx ?? 0
  const target = firstRetainedIdx - 1
  if (target <= covered) return

  const events = ctx.eventLog
    .query({ sessionId, afterIdx: covered })
    .filter((e: any) => e.idx <= target && (e.eventType === 'user_message' || e.eventType === 'assistant_response'))
  if (events.length < 4) return

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
      model: 'deepseek-chat',
      maxTokens: 4000,
      telemetryContext: { userId: ctx.userId, workspaceId: ctx.userId, action: 'chat.compact_segment' },
    },
  )
  const jsonMatch = result.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return

  const parsed = JSON.parse(jsonMatch[0]) as {
    anchoredSummary?: Record<string, any>
    facts?: Array<Record<string, any>>
    episodeUpdate?: string
  }

  const now = new Date().toISOString()

  // 1) Batch fact proposals → pending review queue.
  let proposed = 0
  if (Array.isArray(parsed.facts)) {
    const gateway = ctx.memory
      ? new MemoryGraphGateway(ctx.userId, ctx.memory, ctx.facts, ctx.episodes, ctx.skills, ctx.knowledge)
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
            conflictsWith: Array.isArray(f.conflictsWith) ? f.conflictsWith.map((sid: any) => ({ stableId: String(sid), content: '' })) : undefined,
          })
          proposed++
        } catch (err) {
          console.log('[COMPACT] Fact proposal skipped:', (err as Error).message.slice(0, 100))
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
  // segments are never re-compacted; summary column stays empty.
  await (prisma as any).kbCompaction.create({
    data: {
      userId: ctx.userId,
      sessionId,
      summary: '',
      coveredUptoIdx: target,
      tokenSavings: null,
      createdAt: now,
    },
  })

  ctx.eventLog.append({
    timestamp: Date.now() / 1000,
    eventType: 'evolution',
    content: `🧠 自动压缩 ${Math.floor(events.length / 2)} 轮对话 → Session Memory 更新${proposed > 0 ? ` + ${proposed} 条事实待审核` : ''}`,
    metadata: { compactedTurns: Math.floor(events.length / 2), proposedFacts: proposed, coveredUptoIdx: target },
    agentId: ctx.userId, sessionId,
  })
  console.log(`[COMPACT] session ${sessionId}: compacted idx ≤${target}, ${proposed} facts proposed, ${events.length} events`)
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
  const { getExtractedUptoIdx, advanceExtractedUptoIdx } = await import('./extraction-cursor.js')
  const scopeKey: { userId: string; scopeType: 'patient' | 'global'; patientHash?: string } = {
    userId: ctx.userId,
    scopeType: patientHash ? 'patient' : 'global',
    patientHash,
  }
  const cursor = await getExtractedUptoIdx(scopeKey)
  const last = await (prisma as any).kbCompaction.findFirst({
    where: { userId: ctx.userId, sessionId },
    orderBy: { coveredUptoIdx: 'desc' },
  })
  const fromIdx = Math.max(cursor, last?.coveredUptoIdx ?? 0)
  const events = ctx.eventLog
    .query({ sessionId, afterIdx: fromIdx })
    .filter((e: any) => e.eventType === 'user_message' || e.eventType === 'assistant_response')
  if (events.length < 2) return 0

  const conversation = events
    .map((e: any) => `${e.eventType === 'user_message' ? 'USER' : 'AI'}: ${String(e.content || '').slice(0, 500)}`)
    .join('\n')
  try {
    const extracted = await extractAndProposeFacts(ctx, patientHash, conversation, {
      sessionId,
      reason: 'session close flush',
    })
    await advanceExtractedUptoIdx(scopeKey, ctx.eventLog.count())
    return extracted.length
  } catch (err) {
    console.log('[FLUSH] Extraction skipped:', (err as Error).message.slice(0, 120))
    return 0
  }
}
