/**
 * #815 — JIT 惰性合成:无文章覆盖的 facts 簇读时综合兜底。
 *
 * 触发面:knowledge_inject 检索命中 ≥3 条 facts 且无任何文章覆盖、
 * 预算处于充足档(合成是追加 LLM 调用,紧张档不做)。产物为
 * ephemeral 注入块(不落图谱);同帧异步经 pending 闸门提案沉淀
 * — 审核通过才成为正式 summary(无直写,BRAIN2 §13.0 闸门语义)。
 *
 * 防抖:同 (userId, query) 10 分钟内只综合一次;in-flight 去重防并发
 * 重复调用。患者隔离:facts 来自 knowledge-inject 的患者过滤检索,
 * 提案 scope 随 patientHash 落位。
 */
import { resolveTierModel } from '../../common/llm-gateway.js'
import { makeLogger } from '../../common/logger.js'
import { CONTEXT_CONFIG } from '../../common/context-config.js'
import type { MemoryService } from '../../memory/memory.service.js'
import { summarySynthesisPrompt } from '../../memory/prompts.js'
import { normalizeSynthesizedSummary } from '../../memory/summary-contract.js'

const log = makeLogger('knowledge.jit-synthesis')

export interface JitFactHit {
  stableId: string
  content: string
  importance?: number
  sourceType?: string
}

export interface JitSynthesisInput {
  userId: string
  query: string
  patientHash?: string | null
  memory: MemoryService
  facts: JitFactHit[]
}

/** 同查询的 JIT 结果短期有效 — 10 分钟内不重复综合。 */
const JIT_TTL_MS = 10 * 60_000
const recentAttempts = new Map<string, number>()
const inFlight = new Set<string>()

function queryKey(userId: string, query: string): string {
  let h = 0
  for (let i = 0; i < query.length; i++) h = ((h << 5) - h + query.charCodeAt(i)) | 0
  return `${userId}:${h}`
}

export function jitRecentlyAttempted(userId: string, query: string): boolean {
  const ts = recentAttempts.get(queryKey(userId, query))
  return !!ts && Date.now() - ts < JIT_TTL_MS
}

/**
 * 读时综合。返回注入用 markdown(结论/依据/caveat 结构,与正式文章
 * 同契约);不可综合(停用/事实不足/LLM 失败/解析失败)返回 null。
 */
export async function maybeJitSynthesize(input: JitSynthesisInput): Promise<string | null> {
  if (!CONTEXT_CONFIG.injection.jitEnabled) return null
  if (input.facts.length < CONTEXT_CONFIG.injection.jitMinFacts) return null
  const key = queryKey(input.userId, input.query)
  if (inFlight.has(key) || jitRecentlyAttempted(input.userId, input.query)) return null

  inFlight.add(key)
  recentAttempts.set(key, Date.now())
  if (recentAttempts.size > 500) {
    // 有界防漏 — 超限全量清一次(TTL 语义由 jitRecentlyAttempted 保证)
    recentAttempts.clear()
  }
  try {
    const picked = input.facts.slice(0, CONTEXT_CONFIG.injection.jitFactsMax)
    const factList = picked
      .map((f) => `[${f.stableId}] importance=${f.importance ?? 3} source=${f.sourceType || 'general'}: ${f.content}`)
      .join('\n')

    const { deepseekChat, getApiKey } = await import('../../common/llm.js')
    const { parseLlmJson } = await import('../../common/llm-json.js')
    const raw = await deepseekChat(
      [{ role: 'user', content: summarySynthesisPrompt(factList) }],
      getApiKey(),
      {
        model: resolveTierModel('fast'),
        maxTokens: 900,
        telemetryContext: { userId: input.userId, workspaceId: input.userId, action: 'memory.jit_synthesis' },
      },
    )
    const normalized = normalizeSynthesizedSummary(parseLlmJson<unknown>(raw), picked.map((f) => f.stableId))
    if (!normalized) {
      log.info('[JIT] synthesis skipped: unparseable contract', { userId: input.userId })
      return null
    }

    // 异步沉淀(不阻塞本轮注入):经 pending 闸门,审核通过才成文。
    void proposeForReview(input, normalized, picked.map((f) => f.stableId))
      .catch((err: Error) => log.warn('[JIT] settle skipped', { reason: err.message.slice(0, 120) }))

    return normalized.content
  } catch (err) {
    log.info('[JIT] synthesis skipped', { reason: (err as Error).message?.slice(0, 120) })
    return null
  } finally {
    inFlight.delete(key)
  }
}

async function proposeForReview(
  input: JitSynthesisInput,
  normalized: { title: string; content: string },
  relatedFacts: string[],
): Promise<void> {
  const { MemoryGraphGateway } = await import('../../memory/memory-gateway.js')
  const gateway = new MemoryGraphGateway(input.userId, input.memory)
  await gateway.propose({
    scopeType: input.patientHash ? 'patient' : 'global',
    patientHash: input.patientHash || undefined,
    kind: 'summary',
    content: normalized.content,
    importance: 3,
    confidence: 'medium',
    reason: 'JIT read-time synthesis (ephemeral; awaiting review)',
    relatedFacts,
  })
  log.info('[JIT] summary proposed for review', { userId: input.userId, title: normalized.title })
}
