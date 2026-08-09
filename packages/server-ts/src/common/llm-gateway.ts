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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
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

export interface LlmChatOptions {
  model?: string
  maxTokens?: number
  temperature?: number
  telemetryContext?: LlmTelemetryContext
  /** External abort signal (client disconnect) — combined with the
   *  internal timeout via AbortSignal.any. */
  signal?: AbortSignal
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
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY', modelEnv: 'DEFAULT_LLM_MODEL', defaultModel: 'gemini-2.5-flash' },
  openai: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', modelEnv: 'DEFAULT_LLM_MODEL', defaultModel: 'gpt-4o-mini' },
  kimi: { baseUrl: 'https://api.moonshot.cn/v1', apiKeyEnv: 'KIMI_API_KEY', modelEnv: 'DEFAULT_LLM_MODEL', defaultModel: 'moonshot-v1-8k' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY', modelEnv: 'DEFAULT_LLM_MODEL', defaultModel: 'claude-3-5-sonnet-latest' },
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
  const timeoutMs = opts.timeoutMs ?? 60000
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
  throw lastErr ?? new Error(FRIENDLY_LLM_ERROR)
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
  return messages.reduce((acc, m) => acc + (m.content?.length || 0), 0)
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

  /** Model resolution: explicit option > provider modelEnv > legacy default. */
  private resolveModel(options: LlmChatOptions, legacyDefault: string): string {
    if (options.model) return options.model
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
    const model = this.resolveModel(options, DEEPSEEK_CHAT_MODEL)
    const body: any = {
      model,
      messages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
    }
    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    const res = await fetchWithRetry(`${this.endpoint().baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.getApiKey()}` },
      body: JSON.stringify(body),
    }, { signal: options.signal })
    if (!res.ok) {
      throw new Error(FRIENDLY_LLM_ERROR)
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
      if (blocks.length > 0) return blocks.join('\n')
    }

    const content = choice?.message?.content || ''

    const usage = json?.usage
    if (usage && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number') {
      await recordUsage(model, options, usage.prompt_tokens, usage.completion_tokens, usage.prompt_cache_hit_tokens || 0, usage.prompt_cache_miss_tokens || 0)
    } else {
      const pTokens = approximateTokensFromChars(promptChars(messages))
      const cTokens = approximateTokensFromChars(content.length)
      await recordUsage(model, options, pTokens, cTokens)
    }
    return content
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
        messages,
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.7,
        stream: true,
        stream_options: { include_usage: true },
      }),
    }, { signal: options.signal })
    if (!res.ok) {
      throw new Error(FRIENDLY_LLM_ERROR)
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let completionChars = 0
    let finalUsage: LlmChunk['usage'] | undefined

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
          if (data === '[DONE]') return
          try {
            const chunk: LlmChunk = JSON.parse(data)
            if (chunk.usage) {
              finalUsage = chunk.usage
              continue
            }
            const delta = chunk.choices?.[0]?.delta
            const reasoningContent = delta?.reasoning_content
            if (reasoningContent && onReasoning) {
              onReasoning(reasoningContent)
            }
            const content = delta?.content
            if (content) {
              completionChars += content.length
              yield content
            }
          } catch { /* skip parse errors */ }
        }
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
