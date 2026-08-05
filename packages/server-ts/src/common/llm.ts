// DeepSeek LLM client — OpenAI-compatible Chat Completions API
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1'
export const FRIENDLY_LLM_ERROR = '服务暂时不可用，请稍后重试'

/**
 * #184 — fetch with timeout + retry (429/5xx, exponential backoff honoring
 * Retry-After). Timeouts and network failures raise friendly errors instead
 * of raw strings.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { maxRetries?: number; timeoutMs?: number; delayMs?: number } = {},
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
      const res = await fetch(url, { ...init, signal: controller.signal })
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

interface ChatMessage {
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

export interface DeepSeekCallOptions {
  model?: string
  maxTokens?: number
  temperature?: number
  telemetryContext?: LlmTelemetryContext
}

interface DeepSeekChunk {
  choices?: Array<{ delta?: { content?: string; reasoning_content?: string; role?: string }; finish_reason?: string | null }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
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
  options: DeepSeekCallOptions,
  promptTokens: number,
  completionTokens: number,
): Promise<void> {
  const totalTokens = promptTokens + completionTokens
  const costUsd = estimateCost(model, promptTokens, completionTokens)
  console.log(`[LLM] model=${model} prompt=${promptTokens} completion=${completionTokens} total=${totalTokens} costUsd≈${costUsd.toFixed(6)}`)
  if (options.telemetryContext && telemetryRecorder) {
    await telemetryRecorder
      .record({
        userId: options.telemetryContext.userId,
        workspaceId: options.telemetryContext.workspaceId,
        category: 'llm_cost',
        action: options.telemetryContext.action,
        metadata: { model, promptTokens, completionTokens, totalTokens, costUsd },
      })
      .catch(() => {})
  }
}

/**
 * Non-streaming call — used for simple completions and tool calls
 *
 * ``onReasoning`` is invoked (if provided) when the model streams a
 * reasoning_content field (DeepSeek reasoner models). Callers that
 * want to surface the thinking process live pass a callback.
 */
export async function deepseekChat(
  messages: ChatMessage[],
  apiKey: string,
  options: DeepSeekCallOptions = {},
  tools?: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
  onReasoning?: (text: string) => void,
): Promise<string> {
  const model = options.model || DEEPSEEK_CHAT_MODEL
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
  const res = await fetchWithRetry(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(FRIENDLY_LLM_ERROR)
  }
  const json = await res.json()
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
    await recordUsage(model, options, usage.prompt_tokens, usage.completion_tokens)
  } else {
    const pTokens = approximateTokensFromChars(promptChars(messages))
    const cTokens = approximateTokensFromChars(content.length)
    await recordUsage(model, options, pTokens, cTokens)
  }
  return content
}

/**
 * Streaming call — yields chunks via AsyncGenerator
 *
 * ``onReasoning`` (if provided) is called for each reasoning_content
 * delta so callers can stream the thinking process to the client
 * alongside the final answer.
 */
export async function* deepseekStream(
  messages: ChatMessage[],
  apiKey: string,
  options: DeepSeekCallOptions = {},
  onReasoning?: (text: string) => void,
): AsyncGenerator<string> {
  const model = options.model || DEEPSEEK_PREMIUM_MODEL
  const res = await fetchWithRetry(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
      stream: true,
      stream_options: { include_usage: true },
    }),
  })
  if (!res.ok) {
    throw new Error(FRIENDLY_LLM_ERROR)
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completionChars = 0
  let finalUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined

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
          const chunk: DeepSeekChunk = JSON.parse(data)
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
    await recordUsage(model, options, finalUsage.prompt_tokens, finalUsage.completion_tokens)
  } else {
    const pTokens = approximateTokensFromChars(promptChars(messages))
    const cTokens = approximateTokensFromChars(completionChars)
    await recordUsage(model, options, pTokens, cTokens)
  }
}

export function getApiKey(): string {
  // Hard-coded keys are forbidden — the key MUST come from the environment.
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) {
    throw new Error('DEEPSEEK_API_KEY is not configured')
  }
  return key
}
