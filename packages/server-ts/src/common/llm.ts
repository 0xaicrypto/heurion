// DeepSeek LLM client — OpenAI-compatible Chat Completions API
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1'
/** Default cheap model for classifiers, extractors, and background tasks. */
export const DEEPSEEK_CHAT_MODEL = process.env.DEEPSEEK_CHAT_MODEL || 'deepseek-v4-flash'
/** Optional premium model for high-stakes chat / document editing. */
export const DEEPSEEK_PREMIUM_MODEL = process.env.DEEPSEEK_PREMIUM_MODEL || 'deepseek-v4-pro'

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
  choices?: Array<{ delta?: { content?: string; role?: string }; finish_reason?: string | null }>
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
 * Non-streaming call — used for simple completions
 */
export async function deepseekChat(
  messages: ChatMessage[],
  apiKey: string,
  options: DeepSeekCallOptions = {},
): Promise<string> {
  const model = options.model || DEEPSEEK_CHAT_MODEL
  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
    }),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`DeepSeek API ${res.status}: ${err.slice(0, 200)}`)
  }
  const json = await res.json()
  const content = json.choices?.[0]?.message?.content || ''

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
 */
export async function* deepseekStream(
  messages: ChatMessage[],
  apiKey: string,
  options: DeepSeekCallOptions = {},
): AsyncGenerator<string> {
  const model = options.model || DEEPSEEK_PREMIUM_MODEL
  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
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
    const err = await res.text().catch(() => '')
    throw new Error(`DeepSeek API ${res.status}: ${err.slice(0, 200)}`)
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
          const content = chunk.choices?.[0]?.delta?.content
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
  return process.env.DEEPSEEK_API_KEY || 'sk-edc3839a3dd44babaf33dc16d0761dc3'
}
