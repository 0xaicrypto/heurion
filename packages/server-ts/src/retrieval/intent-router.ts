/**
 * #452 — IntentRouter: unified sidecar-intent resolution (Chain of
 * Responsibility). One place decides "is this a document/render request":
 *
 *   1. Rule candidate recall (plugin triggers + keyword layer) — NEVER the
 *      final word (#549): discussion sentences like "这个表格的数字怎么来的"
 *      or "帮我做一下脑电图的分析" must not generate files.
 *   2. LLM adjudicator — when a candidate exists but is not a strong
 *      generate signal, a cheap classifier decides generate/discuss/uncertain.
 *      discuss/uncertain/failure → normal conversation (conservative by design).
 *   3. Strong signals (verb + format word) skip the LLM call entirely.
 *
 * The router classification itself stays in retrieval/query-router (rule +
 * LLM, cached per query — plugin matching must NOT enter that cache because
 * it is per-user).
 */
import { deepseekChat, getApiKey, DEEPSEEK_CHAT_MODEL, type LlmTelemetryContext } from '../common/llm.js'
import { matchIntent } from '../modules/plugins/plugin-capability.service.js'
import { classifySidecarIntent } from './query-router.js'

export type SidecarDecision = 'generate' | 'discuss' | 'uncertain'

export interface SidecarHistoryEntry {
  role: string
  content: string
}

export interface SidecarClassifier {
  classify(text: string, history?: SidecarHistoryEntry[]): Promise<SidecarDecision>
}

/**
 * #549 — default LLM adjudicator: a single cheap call that strictly
 * distinguishes "generate a NEW file" from "discussing existing content".
 * Any failure/unknown answer degrades to 'uncertain' (safe: no generation).
 */
export function createDefaultSidecarClassifier(context?: LlmTelemetryContext): SidecarClassifier {
  return {
    async classify(text: string, history?: SidecarHistoryEntry[]): Promise<SidecarDecision> {
      const apiKey = getApiKey()
      if (!apiKey) return 'uncertain'
      try {
        const raw = await deepseekChat([{ role: 'user', content: buildSidecarClassifierPrompt(text, history) }], apiKey, {
          model: DEEPSEEK_CHAT_MODEL,
          maxTokens: 20,
          telemetryContext: context,
        })
        const decision = raw.trim().toLowerCase().split(/\s+/)[0]
        if (decision === 'generate' || decision === 'discuss' || decision === 'uncertain') {
          return decision
        }
        return 'uncertain'
      } catch {
        return 'uncertain'
      }
    },
  }
}

function buildSidecarClassifierPrompt(text: string, history?: SidecarHistoryEntry[]): string {
  const safeQuery = text.replace(/"/g, '\\"')
  const historyBlock = history && history.length > 0
    ? `Conversation history (recent, latest first):\n${history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n')}\n\n`
    : ''
  return `You are a strict intent classifier for a clinical assistant. Decide whether the user is asking to GENERATE/CREATE/EXPORT a NEW file (document, presentation, table, plot, PDF) — not merely mentioning one.
- generate: the user explicitly asks to create/produce/export a file. Examples: "帮我生成一份出院小结 docx", "把这个表格导出为 PDF", "make me a PPT about the case".
- discuss: the user is discussing, asking about, or interpreting EXISTING content. Examples: "这个表格的数字怎么来的", "上次那个 PPT 讲了什么", "这个图怎么解读", "help me understand this chart".
- uncertain: anything else or ambiguous. IMPORTANT: EDITING/POLISHING an existing document is NOT generate — "帮我润色修改这篇论文", "改一下这份病例", "polish this manuscript" mean working on content that already exists; return uncertain unless the user explicitly asks to produce a NEW file.
${historyBlock}User: "${safeQuery}"
Return ONLY one word: generate|discuss|uncertain`
}

const SIDECAR_CACHE_TTL_MS = 5 * 60 * 1000
/** #199: bounded cache — same query must not re-pay the adjudicator call. */
const SIDECAR_CACHE_MAX = 500
const sidecarCache = new Map<string, { decision: boolean; expires: number }>()

/** Clear the in-memory sidecar decision cache (tests). */
export function clearSidecarCache(): void {
  sidecarCache.clear()
}

export interface ResolveSidecarOptions {
  /** Recent conversation turns — helps the adjudicator understand reference. */
  history?: SidecarHistoryEntry[]
  /** Test hook: override the LLM adjudicator. */
  classifier?: SidecarClassifier
}

/**
 * True when the query is a document/render request.
 *
 * Pipeline: strong rule signal → true (no LLM cost); no candidate → false
 * (no LLM cost); weak candidate / plugin trigger match → LLM adjudicator
 * decide → only 'generate' returns true. Everything else is treated as
 * normal conversation (conservative: never generate on doubt).
 */
export async function resolveSidecarIntent(
  userId: string,
  text: string,
  opts: ResolveSidecarOptions = {},
): Promise<boolean> {
  const key = `${userId}|${text.trim().toLowerCase()}`
  const cached = sidecarCache.get(key)
  if (cached && cached.expires > Date.now()) {
    return cached.decision
  }

  let decision: boolean
  const candidate = classifySidecarIntent(text)
  if (candidate === 'strong') {
    // #549: strong generate signal (verb + format word, no discussion
    // markers) — direct pass, zero LLM cost.
    decision = true
  } else if (candidate === null) {
    const pluginMatch = await matchIntent(userId, text)
    if (!pluginMatch) {
      decision = false
    } else {
      decision = await adjudicate(opts, text)
    }
  } else {
    decision = await adjudicate(opts, text)
  }

  sidecarCache.set(key, { decision, expires: Date.now() + SIDECAR_CACHE_TTL_MS })
  if (sidecarCache.size > SIDECAR_CACHE_MAX) {
    const oldest = sidecarCache.keys().next().value
    if (oldest !== undefined) sidecarCache.delete(oldest)
  }
  return decision
}

async function adjudicate(opts: ResolveSidecarOptions, text: string): Promise<boolean> {
  // #549: any adjudicator failure degrades to 'discuss' — never generate on doubt.
  try {
    const classifier = opts.classifier ?? createDefaultSidecarClassifier()
    const verdict = await classifier.classify(text, opts.history)
    return verdict === 'generate'
  } catch {
    return false
  }
}