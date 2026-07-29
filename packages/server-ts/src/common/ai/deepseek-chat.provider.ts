import type { AiProvider, AiProviderConfig, ChatMessage, ChatOptions, ChatResult } from './ai-provider.js'
import { AiProviderError } from './ai-provider.js'

const DEEPSEEK_BASE = 'https://api.deepseek.com/v1'

export class DeepSeekChatProvider implements Pick<AiProvider, 'chat'> {
  constructor(private config: AiProviderConfig = {}) {}

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const apiKey = this.config.deepseekApiKey || process.env.DEEPSEEK_API_KEY
    if (!apiKey) {
      throw new AiProviderError('DEEPSEEK_API_KEY is not configured', 'config_missing')
    }

    const model = options.model || this.config.deepseekChatModel || 'deepseek-chat'
    const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.7,
      }),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new AiProviderError(
        `DeepSeek API error ${resp.status}: ${text.slice(0, 200)}`,
        'api_error',
        resp.status,
      )
    }

    const data: any = await resp.json()
    const content = data?.choices?.[0]?.message?.content || ''
    const usage = data?.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : undefined

    return { content, model, usage }
  }
}
