/**
 * #452/#557 — IntentRouter: SINGLE authority for "is this a file-generation
 * request". Converged to a two-layer pipeline:
 *
 *   1. Deterministic veto (zero LLM cost): EDIT/DISCUSSION markers → never
 *      generate. Rules here only say NO; they never say yes.
 *   2. One LLM adjudication: everything that survives the veto is classified
 *      generate / discuss / uncertain by a single cheap call. Only
 *      'generate' proceeds; discuss/uncertain/failure → normal conversation
 *      (conservative by design — never generate on doubt).
 *
 * The regex candidate-recall layer (STRONG_GENERATE_VERBS / FILE_FORMAT_WORDS
 * / WEAK_SIDECAR_PHRASES + strong-signal direct pass) was removed in #557:
 * every missed variant ("把这篇论文排版成 Word 发我", "给我整体润色一遍再发我",
 * "给我总结一下治疗经过") cost a patch round. A single LLM call covers the
 * whole tail; the veto keeps the cheap, deterministic protection.
 *
 * Plugin matching (matchIntent) is NOT consulted here anymore — the plugin
 * layer confirms which plugin exists AFTER the LLM says generate (see
 * plugin-chat-handler.ts).
 */
import { deepseekChat, getApiKey, DEEPSEEK_CHAT_MODEL, type LlmTelemetryContext } from '../common/llm.js'
import { isSidecarVetoed } from './query-router.js'
import { SemanticIntentRouter, type SemanticVerdict } from './semantic-intent-router.js'
import { SEMANTIC_GENERATE_SEEDS, SEMANTIC_VETO_SEEDS } from './semantic-seeds.js'

export type SidecarDecision = 'generate' | 'discuss' | 'uncertain'

export interface SidecarHistoryEntry {
  role: string
  content: string
}

export interface SidecarClassifier {
  classify(text: string, history?: SidecarHistoryEntry[]): Promise<SidecarDecision>
}

/**
 * #549/#557 — default LLM adjudicator: a single cheap call that strictly
 * distinguishes "generate a NEW file" from "discussing/editing existing
 * content". Any failure/unknown answer degrades to 'uncertain' (safe).
 */
export function createDefaultSidecarClassifier(context?: LlmTelemetryContext): SidecarClassifier {
  return {
    async classify(text: string, history?: SidecarHistoryEntry[]): Promise<SidecarDecision> {
      const apiKey = getApiKey()
      if (!apiKey) return 'uncertain'
      try {
        const raw = await deepseekChat([{ role: 'user', content: buildSidecarClassifierPrompt(text, history) }], apiKey, {
          model: DEEPSEEK_CHAT_MODEL,
          maxTokens: 50,
          telemetryContext: context,
        })
        const decision = raw.trim().toLowerCase().split(/\s+/)[0]
        // #557: legacy protocol values still map (old prompts replied
        // 'sidecar'/'normal'); anything unknown degrades to 'uncertain' (safe).
        if (decision === 'sidecar') return 'generate'
        if (decision === 'normal') return 'discuss'
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
  return `You are a strict intent classifier for a clinical assistant. Decide whether the user asks to GENERATE/CREATE/EXPORT a NEW file (document, presentation, table, plot, PDF) — not merely mention one, and not edit content that already exists.
- generate: the user EXPLICITLY asks to create a new file. Examples: "帮我生成一份出院小结 docx", "把这份数据做成 PPT 汇报", "make me a PPT about this case", "导出为 PDF".
- discuss: the user is asking about, interpreting, or summarizing EXISTING content, or wants a plain-text answer. Examples: "这个表格的数字怎么来的", "上次那个 PPT 讲了什么", "这个图怎么解读", "帮我总结一下治疗经过" (a verbal summary, NOT a file).
- uncertain: anything else, ambiguous, or mixed (e.g. discussing a table AND asking to export it later; a long pasted manuscript with a short request; "把这篇论文排版成 Word 发我"). NEVER guess.

Hard rules:
- EDITING/POLISHING/REVISING an existing document is NEVER generate: 润色/修改/改写/重写/完善/排版/polish/edit/revise/rewrite → uncertain or discuss.
- Pasting a long document body (paper/manuscript) with a short request is never a generate signal on its own — the file to generate does not exist yet.
- "总结/概括/归纳" without an explicit document-context word is discuss (verbal summary), NOT generate.
- When unsure between generate and anything else, return uncertain.
${historyBlock}User: "${safeQuery}"
Return ONLY one word: generate|discuss|uncertain`
}

const SIDECAR_CACHE_TTL_MS = 5 * 60 * 1000
/** #199: bounded cache — same query must not re-pay the adjudicator call. */
const SIDECAR_CACHE_MAX = 500
const sidecarCache = new Map<string, { decision: boolean; verdict: SidecarDecision | 'vetoed'; detail: SidecarDecisionDetail; expires: number }>()

/**
 * #558 — cache key must include a HISTORY fingerprint: the same bare text
 * means different things in different conversations ("做好了发我" only refers
 * to a PPT because of earlier turns). Without it a cached decision leaks
 * across sessions and gets stuck on the wrong side of generate/discuss.
 */
function historyFingerprint(history?: SidecarHistoryEntry[]): string {
  if (!history || history.length === 0) return ''
  const tail = history.slice(-2).map((m) => `${m.role}:${m.content}`).join('\n')
  let h = 5381
  for (let i = 0; i < tail.length; i++) {
    h = ((h << 5) + h + tail.charCodeAt(i)) >>> 0
  }
  return String(h)
}

/** Clear the in-memory sidecar decision cache (tests). */
export function clearSidecarCache(): void {
  sidecarCache.clear()
}

/** #562 — reset the lazily-built semantic router (tests switch env modes). */
export function resetSemanticRouterForTests(): void {
  semanticRouter = undefined
}

export interface ResolveSidecarOptions {
  /** Recent conversation turns — helps the adjudicator understand reference. */
  history?: SidecarHistoryEntry[]
  /** Test hook: override the LLM adjudicator. */
  classifier?: SidecarClassifier
  /**
   * #561 — receive the detailed decision (verdict / vetoed / llmCalls /
   * cacheHit) so callers can surface the tri-state to the UI (e.g. an
   * "intent_clarify" event when the LLM is uncertain) instead of only
   * a boolean.
   */
  onDecision?: (detail: SidecarDecisionDetail) => void
}

/** #560/#561 — observable decision detail for telemetry & UI clarification. */
export interface SidecarDecisionDetail {
  verdict: SidecarDecision | 'vetoed'
  vetoed: boolean
  llmCalls: number
  cacheHit: boolean
  textLength: number
  historyTurns: number
  /** #562 — semantic router verdict when enabled (shadow/on); undefined otherwise. */
  semantic?: SemanticVerdict
}

/**
 * True when the query is a document/render request.
 *
 * Pipeline (#557): veto → one LLM adjudication. Vetoed or any verdict other
 * than 'generate' → false (normal conversation; never generate on doubt).
 */
export async function resolveSidecarIntent(
  userId: string,
  text: string,
  opts: ResolveSidecarOptions = {},
): Promise<boolean> {
  const key = `${userId}|${text.trim().toLowerCase()}|${historyFingerprint(opts.history)}`
  const cached = sidecarCache.get(key)
  if (cached && cached.expires > Date.now()) {
    opts.onDecision?.({
      verdict: cached.verdict,
      vetoed: cached.detail.vetoed,
      llmCalls: cached.detail.llmCalls,
      cacheHit: true,
      textLength: text.length,
      historyTurns: opts.history?.length ?? 0,
    })
    return cached.decision
  }

  const result = await adjudicate(opts, text)
  sidecarCache.set(key, { decision: result.decision, verdict: result.detail.verdict, expires: Date.now() + SIDECAR_CACHE_TTL_MS, detail: result.detail })
  if (sidecarCache.size > SIDECAR_CACHE_MAX) {
    const oldest = sidecarCache.keys().next().value
    if (oldest !== undefined) sidecarCache.delete(oldest)
  }
  return result.decision
}

// #562 — semantic router instance (lazy; embedding service may be absent).
let semanticRouter: SemanticIntentRouter | null | undefined

async function getSemanticRouter(): Promise<SemanticIntentRouter | null> {
  if (semanticRouter !== undefined) return semanticRouter
  const mode = process.env.INTENT_SEMANTIC_ROUTER || 'off'
  if (mode !== 'on' && mode !== 'shadow') {
    semanticRouter = null
    return null
  }
  try {
    const { createAiProvider } = await import('../common/ai/ai-provider.js')
    const provider = createAiProvider()
    semanticRouter = new SemanticIntentRouter({
      embed: (texts) => provider.embed(texts),
      generateSeeds: SEMANTIC_GENERATE_SEEDS,
      vetoSeeds: SEMANTIC_VETO_SEEDS,
    })
  } catch {
    semanticRouter = null
  }
  return semanticRouter
}

async function adjudicate(opts: ResolveSidecarOptions, text: string): Promise<{ decision: boolean; detail: SidecarDecisionDetail }> {
  // #557: deterministic veto first — zero LLM cost, and the veto is final:
  // editing/discussion sentences must never pay for adjudication either.
  if (isSidecarVetoed(text)) {
    const detail: SidecarDecisionDetail = {
      verdict: 'vetoed', vetoed: true, llmCalls: 0, cacheHit: false,
      textLength: text.length, historyTurns: opts.history?.length ?? 0,
    }
    opts.onDecision?.(detail)
    return { decision: false, detail }
  }
  // #562/#585: semantic router (opt-in, shadow/on).
  //  - 'on' (灰度): 高置信 generate/veto 直接落定（0 LLM）；uncertain 回落 LLM。
  //  - 'shadow' (影子): 只探测语义判定并随 detail.semantic 上报，不参与决定——
  //    供离线评估"语义 vs LLM 分歧率"（门槛 <5% 才切换 on），绝不误放行。
  const semanticMode = process.env.INTENT_SEMANTIC_ROUTER || 'off'
  let semanticProbe: SemanticVerdict | undefined
  try {
    const semantic = await getSemanticRouter()
    if (semantic && semanticMode !== 'off') {
      const semanticVerdict = await semantic.classify(text)
      if (semanticMode === 'on' && (semanticVerdict === 'generate' || semanticVerdict === 'veto')) {
        const detail: SidecarDecisionDetail = {
          verdict: semanticVerdict === 'generate' ? 'generate' : 'discuss',
          vetoed: semanticVerdict === 'veto',
          llmCalls: 0,
          cacheHit: false,
          textLength: text.length,
          historyTurns: opts.history?.length ?? 0,
          semantic: semanticVerdict,
        }
        opts.onDecision?.(detail)
        return { decision: semanticVerdict === 'generate', detail }
      }
      // shadow 与 uncertain → 记录探测，继续走 LLM 兜底。
      semanticProbe = semanticVerdict
    }
  } catch {
    // semantic layer outage → fall through to LLM (never block on doubt).
  }
  // #549: any adjudicator failure degrades to 'discuss' — never generate on doubt.
  try {
    const classifier = opts.classifier ?? createDefaultSidecarClassifier()
    const verdict = await classifier.classify(text, opts.history)
    const detail: SidecarDecisionDetail = {
      verdict, vetoed: false, llmCalls: 1, cacheHit: false,
      textLength: text.length, historyTurns: opts.history?.length ?? 0,
      semantic: semanticProbe,
    }
    opts.onDecision?.(detail)
    return { decision: verdict === 'generate', detail }
  } catch {
    const detail: SidecarDecisionDetail = {
      verdict: 'uncertain', vetoed: false, llmCalls: 1, cacheHit: false,
      textLength: text.length, historyTurns: opts.history?.length ?? 0,
      semantic: semanticProbe,
    }
    opts.onDecision?.(detail)
    return { decision: false, detail }
  }
}