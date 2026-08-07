import { AiProviderError, type AiProvider, type AiProviderConfig, type ChatMessage, type ChatOptions, type ChatResult } from './ai-provider.js'
import { isRetryable, sleep } from './deepseek-chat.provider.js'

const MAX_RETRIES = 2

/**
 * #202: a generic OpenAI-compatible chat provider — DeepSeek, Gemini
 * (OpenAI-compat endpoint), Kimi/Moonshot, OpenAI and most vLLM/Ollama
 * gateways all speak this protocol. Enabled at runtime via
 * DEFAULT_LLM_PROVIDER without code changes.
 */
export class OpenAICompatibleChatProvider implements Pick<AiProvider, 'chat'> {
  constructor(
    private config: AiProviderConfig = {},
    private overrides: { baseUrl: string; apiKey: string; model: string },
  ) {}

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const apiKey = this.overrides.apiKey || this.config.deepseekApiKey || process.env.DEEPSEEK_API_KEY
    if (!apiKey) {
      throw new AiProviderError('provider API key is not configured', 'config_missing')
    }

    const model = options.model || this.overrides.model

    let lastError: unknown
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.requestChat(apiKey, model, messages, options)
      } catch (err) {
        lastError = err
        if (!isRetryable(err) || attempt === MAX_RETRIES) throw err
        await sleep(1000 * 2 ** attempt)
      }
    }
    throw lastError
  }

  private async requestChat(
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    options: ChatOptions,
  ): Promise<ChatResult> {
    const base = this.overrides.baseUrl.replace(/\/$/, '')
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        stream: false,
      }),
      signal: options.signal,
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new AiProviderError(
        `Chat API error ${resp.status}: ${text.slice(0, 200)}`,
        resp.status === 429 || resp.status >= 500 ? 'api_error' : 'api_error',
        resp.status,
      )
    }

    const data: any = await resp.json()
    const content = data?.choices?.[0]?.message?.content ?? ''
    return {
      content,
      model: data?.model || model,
      usage: {
        promptTokens: data?.usage?.prompt_tokens ?? 0,
        completionTokens: data?.usage?.completion_tokens ?? 0,
        totalTokens: data?.usage?.total_tokens ?? 0,
      },
    }
  }
}

/** #202: provider registry — runtime selection via DEFAULT_LLM_PROVIDER. */
export interface ProviderRegistryEntry {
  baseUrl: string
  apiKeyEnv: string
  modelEnv: string
  defaultModel: string
}

export const OPENAI_COMPATIBLE_PROVIDERS: Record<string, ProviderRegistryEntry> = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', modelEnv: 'DEEPSEEK_CHAT_MODEL', defaultModel: 'deepseek-chat' },
  // OpenCode Zen gateway — deepseek-v4-flash / deepseek-v4-pro via the
  // OpenAI-compatible endpoint (key from opencode.ai/auth).
  opencode: { baseUrl: 'https://opencode.ai/zen/v1', apiKeyEnv: 'OPENCODE_API_KEY', modelEnv: 'DEFAULT_LLM_MODEL', defaultModel: 'deepseek-v4-flash' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY', modelEnv: 'DEFAULT_LLM_MODEL', defaultModel: 'gemini-2.5-flash' },
  openai: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', modelEnv: 'DEFAULT_LLM_MODEL', defaultModel: 'gpt-4o-mini' },
  kimi: { baseUrl: 'https://api.moonshot.cn/v1', apiKeyEnv: 'KIMI_API_KEY', modelEnv: 'DEFAULT_LLM_MODEL', defaultModel: 'moonshot-v1-8k' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY', modelEnv: 'DEFAULT_LLM_MODEL', defaultModel: 'claude-3-5-sonnet-latest' },
}

export function resolveChatProvider(config: AiProviderConfig): Pick<AiProvider, 'chat'> {
  const provider = (config.llmProvider || process.env.DEFAULT_LLM_PROVIDER || 'deepseek').toLowerCase()
  const entry = OPENAI_COMPATIBLE_PROVIDERS[provider]
  if (!entry) {
    throw new AiProviderError(`Unknown DEFAULT_LLM_PROVIDER: ${provider}`, 'config_missing')
  }
  return new OpenAICompatibleChatProvider(config, {
    baseUrl: entry.baseUrl,
    apiKey: process.env[entry.apiKeyEnv] || config.deepseekApiKey || '',
    model: process.env[entry.modelEnv] || entry.defaultModel,
  })
}
