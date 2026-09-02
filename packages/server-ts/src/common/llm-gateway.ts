/**
 * #436 — LlmGateway: the SINGLE entry point for LLM calls (Strategy + DIP).
 *
 * Business code depends only on this interface. The default implementation
 * is an OpenAI-compatible chat client (DeepSeek / OpenCode / Gemini-compat /
 * Kimi / OpenAI / Anthropic) with unified retry, telemetry and pricing.
 * Runtime provider selection via DEFAULT_LLM_PROVIDER.
 *
 * `common/llm.ts` is now a thin backward-compatible facade over this gateway
 * (its ~22 call sites keep their signatures unchanged).
 */
export const FRIENDLY_LLM_ERROR = '服务暂时不可用，请稍后重试'

/** #548 — raised when the provider stopped generation because the output
 *  token budget was exhausted (finish_reason='length'). Stream consumers
 *  can surface a "回答被截断" notice instead of marking the reply complete. */
export class LlmTruncatedError extends Error {
  /** True when some final content was produced before the truncation. */
  readonly hadContent: boolean
  /** True when reasoning/thinking chunks were produced. */
  readonly hadReasoning: boolean
  constructor(meta: { hadContent: boolean; hadReasoning: boolean }) {
    super('LLM response was truncated because the output token limit was reached')
    this.name = 'LlmTruncatedError'
    this.hadContent = meta.hadContent
    this.hadReasoning = meta.hadReasoning
  }
}

/** #548 — non-streaming result with truncation metadata. */
export interface LlmChatResult {
  text: string
  /** True when the provider stopped at finish_reason='length'. */
  truncated: boolean
}

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
function truncationRetryBudget(model: string, maxTokens: number | undefined): number {
  const doubled = (maxTokens ?? resolveDefaultMaxTokens(model)) * 2
  const ceiling = MODEL_MAX_OUTPUT_TOKENS[model]
  return ceiling !== undefined && doubled > ceiling ? ceiling : doubled
}

/** #548 — a pure-reasoning truncation retries once with a doubled budget so
 *  the user always gets a visible answer (never a silent zero-output stop). */
const MAX_TRUNCATION_RETRY_DEPTH = 1

/**
 * #511 — multimodal chat content. A message content may be a plain string
 * (legacy) or an array of content parts (text + image). Images are passed
 * as data URLs to OpenAI-compatible /chat/completions; providers without
 * vision support must not receive image parts (the caller falls back to
 * OCR or a textual note instead).
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; dataBase64: string }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

/** #511: providers that accept image_url parts over the OpenAI-compatible
 *  endpoint. deepseek/opencode 默认走 deepseek-v4-flash(支持多模态),
 *  kimi 纯文本 → 由 modelSupportsVision 精确兜底。#784: anthropic 移除
 *  (直连条目已删,claude 经中转站走 OpenAI 兼容端点)。 */
const VISION_PROVIDERS: ReadonlySet<string> = new Set(['gemini', 'openai'])

/** #fix: 明确不支持视觉的模型。v3 时代 DeepSeek(deepseek-chat /
 *  deepseek-reasoner)是纯文本;v4+(deepseek-v4-flash/pro)支持
 *  OpenAI-compatible image_url 多模态输入。 */
const TEXT_ONLY_MODELS: ReadonlySet<string> = new Set(['deepseek-chat', 'deepseek-reasoner'])

/** 按模型名判定视觉能力:已知视觉模型(v4+ 家族,含
 *  deepseek-v4-flash-vision-exp)→ true;已知纯文本模型 → false;
 *  未知模型名保守 false(由调用方用 provider 维度兜底)。 */
export function modelSupportsVision(model: string): boolean {
  const m = model.toLowerCase()
  if (TEXT_ONLY_MODELS.has(m)) return false
  // deepseek-v4 前缀覆盖 flash/pro/vision-exp 等全部 v4 变体;
  // 名称含 vision 的模型也按支持视觉处理。
  if (/^deepseek-v4/.test(m) || /vision/.test(m)) return true
  // #752: GLM-5.x 全系多模态(用户确认 glm-5.3-flash 支持图片输入)。
  if (/^glm-/.test(m)) return true
  return false
}

/**
 * 视觉能力判定(provider + model 双维度)。
 * - 显式传 model:模型明确支持视觉 → true;否则看 provider。
 * - 不传 model(老调用方):deepseek/opencode 默认模型是 deepseek-v4-flash,
 *   按视觉处理;gemini/openai 恒支持;kimi 恒不支持。
 */
export function providerSupportsVision(provider?: string, model?: string): boolean {
  const prov = (provider || process.env.DEFAULT_LLM_PROVIDER || 'deepseek').toLowerCase()
  if (model) return modelSupportsVision(model) || VISION_PROVIDERS.has(prov)
  return VISION_PROVIDERS.has(prov) || prov === 'deepseek' || prov === 'opencode'
}

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
  return process.env[ep.modelEnv] || DEEPSEEK_PREMIUM_MODEL
}

/** Serialize a message content into OpenAI /chat/completions parts. */
export function serializeContent(content: string | ChatContentPart[], model?: string): unknown {
  if (typeof content === 'string') return content
  // #fix: 双保险 — 即使上下文装配阶段已注入图片 part,发往纯文本模型
  // (deepseek-chat/reasoner)前必须降级,否则 provider 直接 400。
  if (model && !modelSupportsVision(model)) {
    return content.map((part) =>
      part.type === 'image'
        ? { type: 'text', text: `[图片附件已省略:当前模型 ${model} 不支持图片输入]` }
        : { type: 'text', text: part.text },
    )
  }
  return content.map((part) => {
    if (part.type === 'image') {
      return { type: 'image_url', image_url: { url: `data:${part.mime};base64,${part.dataBase64}` } }
    }
    return { type: 'text', text: part.text }
  })
}

export interface LlmTelemetryContext {
  userId: string
  workspaceId: string
  action: string
}

export interface LlmTelemetryRecorder {
  record(input: {
    userId: string
    workspaceId: string
    category: 'llm_cost'
    action: string
    metadata: Record<string, unknown>
  }): Promise<void>
}

/** #627 — LLM request timeout (TTFB) with env override LLM_TIMEOUT_MS.
 *  Default 300s: reasoning models on long documents (editing/polishing,
 *  chart generation with full doc context) can think >180s before the
 *  first token — the previous 180s aborted those with "LLM request timed
 *  out after 180000ms". The SSE heartbeat keeps the client connection
 *  alive while the origin waits. */
function resolveLlmTimeoutMs(): number {
  const fromEnv = parseInt(process.env.LLM_TIMEOUT_MS || '', 10)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  return 300000
}

export interface LlmChatOptions {
  model?: string
  maxTokens?: number
  temperature?: number
  /** Override the request timeout (TTFB). Default: LLM_TIMEOUT_MS env or 180s. */
  timeoutMs?: number
  /** #752: GLM 混合思考开关 — 仅 glm-* 模型生效,body.thinking 透传。 */
  thinking?: 'enabled' | 'disabled'
  telemetryContext?: LlmTelemetryContext
  /** External abort signal (client disconnect) — combined with the
   *  internal timeout via AbortSignal.any. */
  signal?: AbortSignal
  /** @internal — pure-reasoning truncation retry guard (never set by callers). */
  retryDepth?: number
}

/** Historical alias kept for compatibility with pre-#436 call sites. */
export type DeepSeekCallOptions = LlmChatOptions

export interface LlmToolDefinition {
  type: string
  function: { name: string; description: string; parameters: Record<string, unknown> }
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

function currentLlmProvider(): string {
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
 * #184 — fetch with timeout + retry (429/5xx, exponential backoff honoring
 * Retry-After). Timeouts and network failures raise friendly errors instead
 * of raw strings.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { maxRetries?: number; timeoutMs?: number; delayMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 2
  const timeoutMs = opts.timeoutMs ?? resolveLlmTimeoutMs()
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let controller: AbortController | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      controller = new AbortController()
      timer = setTimeout(() => controller!.abort(), timeoutMs)
      const signal = opts.signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([opts.signal, controller.signal])
        : controller.signal
      const res = await fetch(url, { ...init, signal })
      if (timer) clearTimeout(timer)
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`)
        if (attempt < maxRetries) {
          const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10)
          const delay = opts.delayMs ?? ((retryAfter || Math.pow(2, attempt)) * 1000)
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
        throw lastErr
      }
      return res
    } catch (err: any) {
      if (timer) clearTimeout(timer)
      lastErr = err
      if (err?.name === 'AbortError') {
        throw new Error(`LLM request timed out after ${timeoutMs}ms`)
      }
      if (attempt < maxRetries) {
        const delay = opts.delayMs ?? Math.pow(2, attempt) * 500
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }
  // 重试耗尽 — 保留具体失败原因(HTTP 状态/超时),前端才能给出可行动的
  // 提示,而不是一律吞成"服务暂时不可用"(用户无法区分 key 失效/限流/网络)。
  if (lastErr) throw lastErr
  throw new Error(FRIENDLY_LLM_ERROR)
}

/** Default cheap model for classifiers, extractors, and background tasks. */
export const DEEPSEEK_CHAT_MODEL = process.env.DEEPSEEK_CHAT_MODEL || 'deepseek-v4-flash'
/** Optional premium model for high-stakes chat / document editing. */
export const DEEPSEEK_PREMIUM_MODEL = process.env.DEEPSEEK_PREMIUM_MODEL || 'deepseek-v4-flash'

interface LlmChunk {
  choices?: Array<{ delta?: { content?: string; reasoning_content?: string; role?: string }; message?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ type: string; function: { name: string; arguments: string } }> }; finish_reason?: string | null }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number }
}

let telemetryRecorder: LlmTelemetryRecorder | undefined

export function setLlmTelemetryService(service?: LlmTelemetryRecorder): void {
  telemetryRecorder = service
}

function getPricing(model: string): { input: number; output: number } {
  const defaults: Record<string, { input: number; output: number }> = {
    'deepseek-chat': { input: 0.27, output: 1.10 },
    'deepseek-reasoner': { input: 0.55, output: 2.19 },
    'deepseek-v4-flash': { input: 0.27, output: 1.10 },
    'deepseek-v4-flash-vision-exp': { input: 0.27, output: 1.10 },
    'deepseek-v4-pro': { input: 0.55, output: 2.19 },
  }
  const envPricing = process.env.LLM_PRICING ? JSON.parse(process.env.LLM_PRICING) : {}
  return (
    envPricing[model] ||
    defaults[model] || {
      input: parseFloat(process.env.LLM_DEFAULT_INPUT_PRICE_PER_1M || '1.0'),
      output: parseFloat(process.env.LLM_DEFAULT_OUTPUT_PRICE_PER_1M || '3.0'),
    }
  )
}

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const p = getPricing(model)
  return (promptTokens * p.input + completionTokens * p.output) / 1_000_000
}

function approximateTokensFromChars(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4))
}

function promptChars(messages: ChatMessage[]): number {
  return messages.reduce((acc, m) => {
    if (typeof m.content === 'string') return acc + m.content.length
    return acc + m.content.reduce((a, p) => a + (p.type === 'text' ? p.text.length : p.dataBase64.length / 2), 0)
  }, 0)
}

/** #511: map message contents to OpenAI parts before sending. */
function serializeMessages(messages: ChatMessage[], model: string): unknown[] {
  return messages.map((m) => ({ role: m.role, content: serializeContent(m.content, model) }))
}

async function recordUsage(
  model: string,
  options: LlmChatOptions,
  promptTokens: number,
  completionTokens: number,
  cacheHitTokens = 0,
  cacheMissTokens = 0,
): Promise<void> {
  const totalTokens = promptTokens + completionTokens
  const costUsd = estimateCost(model, promptTokens, completionTokens)
  // O3 (#108): surface DeepSeek cache usage so cache effectiveness is visible.
  const cachePct = promptTokens > 0 ? Math.round((cacheHitTokens / promptTokens) * 100) : 0
  console.log(`[LLM] model=${model} prompt=${promptTokens} (cache hit ${cacheHitTokens}/${cachePct}%) completion=${completionTokens} total=${totalTokens} costUsd≈${costUsd.toFixed(6)}`)
  if (options.telemetryContext && telemetryRecorder) {
    await telemetryRecorder
      .record({
        userId: options.telemetryContext.userId,
        workspaceId: options.telemetryContext.workspaceId,
        category: 'llm_cost',
        action: options.telemetryContext.action,
        metadata: { model, promptTokens, completionTokens, totalTokens, costUsd, cacheHitTokens, cacheMissTokens, cacheHitPct: cachePct },
      })
      .catch(() => {})
  }
}

export interface LlmGateway {
  /** Non-streaming call — simple completions and tool calls. */
  chat(
    messages: ChatMessage[],
    options?: LlmChatOptions,
    tools?: LlmToolDefinition[],
    onReasoning?: (text: string) => void,
  ): Promise<string>
  /** #548 — non-streaming call with truncation metadata. */
  chatWithMeta(
    messages: ChatMessage[],
    options?: LlmChatOptions,
    tools?: LlmToolDefinition[],
    onReasoning?: (text: string) => void,
  ): Promise<LlmChatResult>
  /** Streaming call — yields content deltas via AsyncGenerator. */
  stream(messages: ChatMessage[], options?: LlmChatOptions, onReasoning?: (text: string) => void): AsyncGenerator<string>
  /** API key for the active provider (from the provider's env var). */
  getApiKey(): string
}

/**
 * Default implementation: OpenAI-compatible Chat Completions client.
 * Provider (base URL + key env + model env) resolved from
 * DEFAULT_LLM_PROVIDER via the registry.
 */
class OpenAICompatibleLlmGateway implements LlmGateway {
  // Endpoint is resolved per-call (env may change at runtime / tests).
  private endpoint(): LlmEndpoint {
    return resolveLlmEndpoint()
  }

  getApiKey(): string {
    // Hard-coded keys are forbidden — the key MUST come from the environment.
    const key = process.env[this.endpoint().apiKeyEnv]
    if (!key) {
      throw new Error(`${this.endpoint().apiKeyEnv} is not configured`)
    }
    return key
  }

  /** Model resolution: explicit option > admin override > provider modelEnv
   *  > legacy default. */
  private resolveModel(options: LlmChatOptions, legacyDefault: string): string {
    if (options.model) return options.model
    if (globalModelOverride) return globalModelOverride
    const fromEnv = process.env[this.endpoint().modelEnv]
    if (fromEnv) return fromEnv
    return legacyDefault
  }

  async chat(
    messages: ChatMessage[],
    options: LlmChatOptions = {},
    tools?: LlmToolDefinition[],
    onReasoning?: (text: string) => void,
  ): Promise<string> {
    return (await this.chatWithMeta(messages, options, tools, onReasoning)).text
  }

  async chatWithMeta(
    messages: ChatMessage[],
    options: LlmChatOptions = {},
    tools?: LlmToolDefinition[],
    onReasoning?: (text: string) => void,
  ): Promise<LlmChatResult> {
    const model = this.resolveModel(options, DEEPSEEK_CHAT_MODEL)
    const body: any = {
      model,
      messages: serializeMessages(messages, model),
      max_tokens: options.maxTokens ?? resolveDefaultMaxTokens(model),
      temperature: options.temperature ?? 0.7,
    }
    // #752: GLM 混合思考 — thinking 参数仅 glm-* 模型接受,其他 provider
    // 不传该字段避免 400。
    if (options.thinking && model.toLowerCase().startsWith('glm')) {
      body.thinking = { type: options.thinking }
    }
    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    const res = await fetchWithRetry(`${this.endpoint().baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.getApiKey()}` },
      body: JSON.stringify(body),
    }, { signal: options.signal, timeoutMs: options.timeoutMs })
    if (!res.ok) {
      // 上游明确拒绝(401 key 失效 / 402 余额 / 429 限流 / 413 超长) —
      // 带状态码 + 上游响应体片段,前端/日志可定位真实原因(如某模型
      // 不支持 tools/image 参数时上游会写明)。
      const body = await res.text().catch(() => '')
      throw new Error(`LLM 请求失败 (HTTP ${res.status}): ${body.slice(0, 300)}`)
    }
    const json: { choices?: LlmChunk['choices']; usage?: LlmChunk['usage'] } = await res.json()
    const choice = json.choices?.[0]

    // Surface the model's reasoning_content (deepseek-reasoner / v4-pro)
    // to callers that want to display the thinking process live.
    const reasoning = choice?.message?.reasoning_content
    if (reasoning && onReasoning) {
      onReasoning(reasoning)
    }

    // Handle tool_calls
    if (choice?.finish_reason === 'tool_calls' && choice.message?.tool_calls) {
      const blocks: string[] = []
      for (const tc of choice.message.tool_calls) {
        if (tc.type === 'function') {
          blocks.push(`<tool_call>${JSON.stringify({ name: tc.function.name, arguments: JSON.parse(tc.function.arguments) })}</tool_call>`)
        }
      }
      if (blocks.length > 0) return { text: blocks.join('\n'), truncated: false }
    }

    // #548: surface finish_reason='length' so callers can tell the user the
    // answer was cut off instead of silently presenting a half reply.
    const truncated = choice?.finish_reason === 'length'
    const content = choice?.message?.content || ''

    const usage = json?.usage
    if (usage && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number') {
      await recordUsage(model, options, usage.prompt_tokens, usage.completion_tokens, usage.prompt_cache_hit_tokens || 0, usage.prompt_cache_miss_tokens || 0)
    } else {
      const pTokens = approximateTokensFromChars(promptChars(messages))
      const cTokens = approximateTokensFromChars(content.length)
      await recordUsage(model, options, pTokens, cTokens)
    }

    // #548: truncated with ZERO visible content = the reasoner burned the
    // whole budget thinking. Retry ONCE with a doubled budget so the user
    // always receives an actual answer. Partial-content truncations and
    // failed retries are returned as-is (caller surfaces the notice).
    const retryDepth = options.retryDepth ?? 0
    if (truncated && !content.trim() && retryDepth < MAX_TRUNCATION_RETRY_DEPTH) {
      return await this.chatWithMeta(
        messages,
        {
          ...options,
          maxTokens: truncationRetryBudget(model, options.maxTokens),
          retryDepth: retryDepth + 1,
        },
        tools,
        onReasoning,
      )
    }

    return { text: content, truncated }
  }

  async *stream(
    messages: ChatMessage[],
    options: LlmChatOptions = {},
    onReasoning?: (text: string) => void,
  ): AsyncGenerator<string> {
    const model = this.resolveModel(options, DEEPSEEK_PREMIUM_MODEL)
    const res = await fetchWithRetry(`${this.endpoint().baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.getApiKey()}` },
      body: JSON.stringify({
        model,
        messages: serializeMessages(messages, model),
        max_tokens: options.maxTokens ?? resolveDefaultMaxTokens(model),
        temperature: options.temperature ?? 0.7,
        stream: true,
        stream_options: { include_usage: true },
        // #752: GLM 混合思考开关(同 chatWithMeta — 仅 glm-* 生效)
        ...(options.thinking && model.toLowerCase().startsWith('glm')
          ? { thinking: { type: options.thinking } }
          : {}),
      }),
    }, { signal: options.signal, timeoutMs: options.timeoutMs })
    if (!res.ok) {
      // 同上 — 流式路径也带状态码 + 上游响应体片段。
      const body = await res.text().catch(() => '')
      throw new Error(`LLM 请求失败 (HTTP ${res.status}): ${body.slice(0, 300)}`)
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let completionChars = 0
    let finalUsage: LlmChunk['usage'] | undefined
    let truncated = false
    // #548: reasoning vs content tracking — a truncation BEFORE any visible
    // content means the reasoner burned the budget thinking; the stream must
    // not end silently with zero output.
    let sawContent = false
    let sawReasoning = false

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          // #548: the provider signals the end of the stream right after a
          // finish_reason='length' chunk — throw before completing so the
          // caller can surface the truncation notice.
          if (data === '[DONE]') {
            if (truncated) break
            return
          }
          try {
            const chunk: LlmChunk = JSON.parse(data)
            if (chunk.usage) {
              finalUsage = chunk.usage
              continue
            }
            const choice = chunk.choices?.[0]
            const delta = choice?.delta
            const reasoningContent = delta?.reasoning_content
            if (reasoningContent) {
              sawReasoning = true
              if (onReasoning) onReasoning(reasoningContent)
            }
            const content = delta?.content
            if (content) {
              sawContent = true
              completionChars += content.length
              yield content
            }
            // #548: detect finish_reason='length' so the caller can surface
            // a truncation notice instead of marking a half reply complete.
            if (choice?.finish_reason === 'length') {
              truncated = true
              break
            }
          } catch { /* skip parse errors */ }
        }
        if (truncated) break
      }
    } finally {
      reader.releaseLock()
    }

    if (finalUsage && typeof finalUsage.prompt_tokens === 'number' && typeof finalUsage.completion_tokens === 'number') {
      await recordUsage(model, options, finalUsage.prompt_tokens, finalUsage.completion_tokens, finalUsage.prompt_cache_hit_tokens || 0, finalUsage.prompt_cache_miss_tokens || 0)
    } else {
      const pTokens = approximateTokensFromChars(promptChars(messages))
      const cTokens = approximateTokensFromChars(completionChars)
      await recordUsage(model, options, pTokens, cTokens)
    }

    if (truncated) {
      // #548: nothing visible was produced — the whole budget went to
      // thinking. Retry ONCE with a doubled budget; only give up (with the
      // trimming metadata) when the retry also fails.
      const retryDepth = options.retryDepth ?? 0
      if (!sawContent && retryDepth < MAX_TRUNCATION_RETRY_DEPTH) {
        try {
          yield* this.stream(
            messages,
            {
              ...options,
              maxTokens: truncationRetryBudget(model, options.maxTokens),
              retryDepth: retryDepth + 1,
            },
            onReasoning,
          )
          return
        } catch (err) {
          if (err instanceof LlmTruncatedError) {
            throw new LlmTruncatedError({ hadContent: false, hadReasoning: sawReasoning || err.hadReasoning })
          }
          throw err
        }
      }
      throw new LlmTruncatedError({ hadContent: sawContent, hadReasoning: sawReasoning })
    }
  }
}

let gateway: LlmGateway | null = null

/** Get the process-wide LlmGateway (lazily initialized, env-read at first use). */
export function getLlmGateway(): LlmGateway {
  if (!gateway) gateway = new OpenAICompatibleLlmGateway()
  return gateway
}

/** Test hook: replace the gateway (e.g. with a mock). */
export function setLlmGatewayForTest(g: LlmGateway | null): void {
  gateway = g
}
