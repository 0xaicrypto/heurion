/**
 * #921 — llm-gateway 拆分:provider 注册/解析/模型预算。
 * 纯机械搬移自 src/common/llm-gateway.ts — 零行为变化。
 */
import type { LlmChatOptions } from './types.js'

/**
 * #548 — per-model max output token budgets (native provider limits).
 * Resolution order: option > MAX_OUTPUT_TOKENS env override > model
 * capability > 4096 safe default. An explicit env var is the admin's
 * global override; without it the chosen model's own limit is used.
 * DeepSeek-style reasoners share this budget between reasoning and the
 * visible answer, which is why the numbers are generous.
 */
const MODEL_MAX_OUTPUT_TOKENS: Readonly<Record<string, number>> = {
  // Gemini (OpenAI-compatible endpoint)
  'gemini-2.5-flash': 8192,
  'gemini-2.5-pro': 65536,
  'gemini-2.0-flash': 8192,
  // DeepSeek V4 (1M context, 384K max output — official docs; no published
  // default, so the native ceiling is used as the generous default).
  'deepseek-v4-flash': 384000,
  'deepseek-v4-flash-vision-exp': 384000,
  'deepseek-v4-pro': 384000,
  // DeepSeek V3-era IDs (max output 8K nominal)
  'deepseek-chat': 8192,
  'deepseek-reasoner': 8192,
  // OpenAI
  'gpt-4o-mini': 16384,
  'gpt-4o': 16384,
  'gpt-4.1-mini': 32768,
  // Anthropic
  'claude-3-5-sonnet-latest': 8192,
  'claude-3-5-haiku-latest': 8192,
  // Moonshot
  'moonshot-v1-8k': 4096,
  'moonshot-v1-32k': 4096,
  'moonshot-v1-128k': 4096,
  // Zhipu GLM-5.x — 混合思考(思维链与可见答案共享预算,预算从宽,同
  // DeepSeek reasoner 口径);glm-5.3-flash 为 #837 起的默认主对话模型。
  'glm-5.3-flash': 96000,
  'glm-5.3': 96000,
}

/** Family fallbacks for unlisted model names (e.g. gemini-2.5-flash-latest). */
const MODEL_FAMILY_DEFAULTS: ReadonlyArray<readonly [string, number]> = [
  ['gemini-', 8192],
  ['gpt-', 16384],
  ['claude-', 8192],
  // #fix: v4 家族整体(含 deepseek-v4-flash-vision-exp 及未来变体)都吃原生
  // 384K 上限;顺序必须在 ['deepseek-', 8192] 之前,前缀越长越先匹配。
  ['deepseek-v4-', 384000],
  ['deepseek-', 8192],
  ['moonshot-', 4096],
  ['kimi-', 4096],
  // #837: GLM 家族兜底(混合思考预算从宽,同 DeepSeek reasoner 口径)。
  ['glm-', 96000],
]

export function resolveDefaultMaxTokens(model?: string): number {
  // Env override first — the admin's explicit global budget wins.
  const fromEnv = parseInt(process.env.MAX_OUTPUT_TOKENS || '', 10)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  // Otherwise match the chosen model's native output capability.
  if (model) {
    const known = MODEL_MAX_OUTPUT_TOKENS[model]
    if (known) return known
    for (const [prefix, budget] of MODEL_FAMILY_DEFAULTS) {
      if (model.startsWith(prefix)) return budget
    }
  }
  return 4096
}

// #548: doubling the budget for a thinking-only truncation retry must never
// exceed the model's native output ceiling (e.g. deepseek-v4-* caps at 384K
// by default — doubling that would produce an invalid request).
/** @internal — shared by gateway.ts / streaming.ts truncation retry. */
export function truncationRetryBudget(model: string, maxTokens: number | undefined): number {
  const doubled = (maxTokens ?? resolveDefaultMaxTokens(model)) * 2
  const ceiling = MODEL_MAX_OUTPUT_TOKENS[model]
  return ceiling !== undefined && doubled > ceiling ? ceiling : doubled
}

/** #548 — a pure-reasoning truncation retries once with a doubled budget so
 *  the user always gets a visible answer (never a silent zero-output stop). */
/** @internal — shared by gateway.ts / streaming.ts truncation retry. */
export const MAX_TRUNCATION_RETRY_DEPTH = 1

export type LlmTier = 'fast' | 'premium' | 'reasoner'

/**
 * #752-mid: 模型分层解析 — 调用点只声明档位,不硬编码具体模型名。
 * 中转站/聚合网关模式下,换模型只改 env,调用点零改动。
 * 优先级:按层 env(LLM_MODEL_*) → legacy deepseek env → provider 主模型。
 */
export function resolveTierModel(tier: LlmTier): string {
  const byTier = tier === 'fast'
    ? process.env.LLM_MODEL_FAST
    : tier === 'premium'
      ? process.env.LLM_MODEL_PREMIUM
      : process.env.LLM_MODEL_REASONER
  if (byTier) return byTier
  // legacy deepseek-named envs(向后兼容既有部署)
  if (tier === 'reasoner' && process.env.DEEPSEEK_REASONER_MODEL) return process.env.DEEPSEEK_REASONER_MODEL
  if (tier !== 'fast' && process.env.DEEPSEEK_PREMIUM_MODEL) return process.env.DEEPSEEK_PREMIUM_MODEL
  // reasoner 档在 opencode(Go 订阅)下默认 glm-5.3-flash:混合思考,
  // 思维链可流式,润色/分析场景的用户体感从"干等"变为"看思考"。
  if (tier === 'reasoner' && (process.env.DEFAULT_LLM_PROVIDER || 'deepseek').toLowerCase() === 'opencode') {
    return 'glm-5.3-flash'
  }
  return resolveActiveModel()
}

// #752-admin: 运行时全局模型覆盖 — admin 在配置页选择后立即生效,
// 持久化在 userSetting('__global__','global_llm_model'),启动时回灌。
let globalModelOverride: string | null = null
export function setGlobalModelOverride(m: string | null): void {
  globalModelOverride = m?.trim() || null
}
export function getGlobalModelOverride(): string | null {
  return globalModelOverride
}

/** 当前生效的主对话模型 — 优先级:admin 运行时覆盖 → provider modelEnv →
 *  默认 deepseek-v4-flash。(显式传 model 的调用点走 tier,不受此影响。) */
export function resolveActiveModel(): string {
  if (globalModelOverride) return globalModelOverride
  const ep = resolveLlmEndpoint()
  return process.env[ep.modelEnv] || resolveLegacyPremiumModel()
}

export interface LlmEndpoint {
  baseUrl: string
  apiKeyEnv: string
  modelEnv: string
  defaultModel: string
}

/** #202: provider registry — runtime selection via DEFAULT_LLM_PROVIDER. */
export const LLM_PROVIDERS: Record<string, LlmEndpoint> = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', modelEnv: 'DEEPSEEK_CHAT_MODEL', defaultModel: 'deepseek-chat' },
  // OpenCode Go gateway — deepseek-v4-flash / deepseek-v4-pro via the
  // OpenAI-compatible endpoint (key from opencode.ai/auth).
  opencode: { baseUrl: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'OPENCODE_API_KEY', modelEnv: 'DEFAULT_LLM_MODEL', defaultModel: 'deepseek-v4-flash' },
  // #752: Zhipu GLM — OpenAI-compatible; GLM-5.x 为混合思考模型,流式
  // delta 带 reasoning_content(需 body.thinking={type:'enabled'},见
  // chatWithMeta/stream 的 glm 分支)。
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnv: 'ZHIPU_API_KEY', modelEnv: 'DEFAULT_LLM_MODEL', defaultModel: 'glm-5.3-flash' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY', modelEnv: 'DEFAULT_LLM_MODEL', defaultModel: 'gemini-2.5-flash' },
  openai: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', modelEnv: 'DEFAULT_LLM_MODEL', defaultModel: 'gpt-4o-mini' },
  kimi: { baseUrl: 'https://api.moonshot.cn/v1', apiKeyEnv: 'KIMI_API_KEY', modelEnv: 'DEFAULT_LLM_MODEL', defaultModel: 'moonshot-v1-8k' },
  // #784: direct-anthropic entry removed. This gateway is an OpenAI-compatible
  // client (/chat/completions + Bearer), while Anthropic's native API is
  // /v1/messages + x-api-key — the entry could never work (ade826c also
  // smuggled its apiKeyEnv to OPENAI_API_KEY). Claude goes through the
  // OpenAI-compatible relay (opencode) instead. claude-* token budgets above
  // stay, keyed by model name for relay-routed models.
}

export function currentLlmProvider(): string {
  return (process.env.DEFAULT_LLM_PROVIDER || 'deepseek').toLowerCase()
}

export function resolveLlmEndpoint(): LlmEndpoint {
  const entry = LLM_PROVIDERS[currentLlmProvider()]
  if (!entry) {
    throw new Error(`Unknown DEFAULT_LLM_PROVIDER: ${currentLlmProvider()}`)
  }
  return entry
}

/**
 * #925/#921 拆分 — 模型 env 惰性读取(原实现是模块加载时快照的 export const,
 * 运行时改 env 不生效)。改为每次调用读 env:除「运行时改 env 即生效」外
 * 行为零差异(默认值与原快照兜底完全一致)。
 */

/** Default cheap model for classifiers, extractors, and background tasks. */
export function resolveLegacyChatModel(): string {
  return process.env.DEEPSEEK_CHAT_MODEL || 'deepseek-v4-flash'
}

/** #802 — TTFB 预算按会话自适应：doc 写作会话的长生成任务（整篇正文
 *  扩写等）首字节/响应头常超默认 300s（现场 9/2：首个工具调用 309s 静默
 *  死亡），放宽到 600s；env LLM_DOC_TIMEOUT_MS 可覆盖。非 doc 会话返回
 *  undefined 走默认。 */
export function resolveTurnTimeoutMs(sessionId?: string): number | undefined {
  if (!sessionId?.startsWith('doc-')) return undefined
  return Number(process.env.LLM_DOC_TIMEOUT_MS) || 600000
}

/** Optional premium model for high-stakes chat / document editing. */
export function resolveLegacyPremiumModel(): string {
  return process.env.DEEPSEEK_PREMIUM_MODEL || 'deepseek-v4-flash'
}

/** #921 拆分 — 原 OpenAICompatibleLlmGateway.resolveModel 私有方法
 *  (Model resolution: explicit option > admin override > provider modelEnv
 *  > legacy default)。语义逐行不变。 */
export function resolveRequestModel(options: LlmChatOptions, legacyDefault: string): string {
  if (options.model) return options.model
  if (globalModelOverride) return globalModelOverride
  const fromEnv = process.env[resolveLlmEndpoint().modelEnv]
  if (fromEnv) return fromEnv
  return legacyDefault
}

/** #921 拆分 — 原 OpenAICompatibleLlmGateway.getApiKey 方法体
 *  (Hard-coded keys are forbidden — the key MUST come from the environment)。
 *  语义逐行不变。 */
export function resolveApiKey(): string {
  const key = process.env[resolveLlmEndpoint().apiKeyEnv]
  if (!key) {
    throw new Error(`${resolveLlmEndpoint().apiKeyEnv} is not configured`)
  }
  return key
}
