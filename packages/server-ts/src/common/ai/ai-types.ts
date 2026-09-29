/** #1146 循环依赖:AI provider 共享类型/错误类下沉叶子模块 — provider
 * 实现(embedding/vision)不再反向导入 ai-provider(工厂)成环。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  model?: string
  maxTokens?: number
  temperature?: number
  telemetryContext?: {
    userId: string
    workspaceId: string
    action: string
  }
  [key: string]: unknown
}

export interface TokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface ChatResult {
  content: string
  model?: string
  usage?: TokenUsage
}

export interface EmbedOptions {
  model?: string
  dimensions?: number
  normalize?: boolean
  telemetryContext?: {
    userId: string
    workspaceId: string
    action: string
  }
  [key: string]: unknown
}

export interface VisionImageInput {
  base64: string
  mimeType?: string
}

export interface VisionOptions {
  model?: string
  mimeType?: string
  telemetryContext?: {
    userId: string
    workspaceId: string
    action: string
  }
  [key: string]: unknown
}

export interface VisionResult {
  content: string
  model?: string
}

export interface AiProvider {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>
  embed(texts: string[], options?: EmbedOptions): Promise<number[][]>
  vision(images: VisionImageInput[], prompt: string, options?: VisionOptions): Promise<VisionResult>
}

export type AiProviderErrorCode =
  | 'config_missing'
  | 'api_error'
  | 'not_implemented'
  | 'timeout'
  | 'invalid_response'

export class AiProviderError extends Error {
  constructor(
    message: string,
    public code: AiProviderErrorCode,
    public statusCode?: number,
    public cause?: Error,
  ) {
    super(message)
    this.name = 'AiProviderError'
  }
}

export interface AiProviderConfig {
  /** #202: runtime LLM provider selection (DEFAULT_LLM_PROVIDER env). */
  llmProvider?: string
  deepseekApiKey?: string
  deepseekChatModel?: string
  geminiApiKey?: string
  geminiVisionModel?: string
  embeddingProvider?: 'local' | 'openai'
  embeddingModel?: string
  embeddingDevice?: 'cpu' | 'cuda' | 'mps'
  embeddingFallbackProvider?: 'openai' | 'none'
  localEmbeddingUrl?: string
  openaiApiKey?: string
  openaiEmbeddingModel?: string
}
