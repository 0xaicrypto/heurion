/**
 * Unified AI Provider abstraction.
 *
 * Business code depends only on `AiProvider`. Switching between DeepSeek,
 * Gemini, local embedding, or OpenAI is done via environment configuration.
 */

import { DeepSeekChatProvider } from './deepseek-chat.provider.js'
import { resolveChatProvider } from './openai-compatible-chat.provider.js'
import { GeminiVisionProvider } from './gemini-vision.provider.js'
import { LocalEmbeddingProvider, ResilientEmbeddingProvider } from './local-embedding.provider.js'
import { OpenAIEmbeddingProvider } from './openai-embedding.provider.js'

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
  [key: string]: any
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
  [key: string]: any
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
  [key: string]: any
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

export function loadAiConfigFromEnv(): AiProviderConfig {
  return {
    llmProvider: process.env.DEFAULT_LLM_PROVIDER || 'deepseek',
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    deepseekChatModel: process.env.DEEPSEEK_CHAT_MODEL || 'deepseek-chat',
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiVisionModel: process.env.GEMINI_VISION_MODEL || 'gemini-2.0-flash',
    embeddingProvider: (process.env.EMBEDDING_PROVIDER as any) || 'local',
    embeddingModel: process.env.EMBEDDING_MODEL || 'BAAI/bge-m3',
    embeddingDevice: (process.env.EMBEDDING_DEVICE as any) || 'cpu',
    embeddingFallbackProvider: (process.env.EMBEDDING_FALLBACK_PROVIDER as any) || 'none',
    localEmbeddingUrl:
      process.env.LOCAL_EMBEDDING_URL ||
      process.env.EMBEDDING_SERVICE_URL ||
      'http://localhost:8003/embed',
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
  }
}

// Minimal telemetry event shape. The wrapper does not depend on any external service.
export interface AiTelemetryEvent {
  action: 'chat' | 'embed' | 'vision'
  model?: string
  latencyMs: number
  success: boolean
  inputCount: number
  outputCount?: number
  usage?: TokenUsage
  errorCode?: string
  metadata?: Record<string, unknown>
}

export interface TelemetryRecorder {
  record(event: AiTelemetryEvent): Promise<void> | void
}

class CompositeAiProvider implements AiProvider {
  constructor(
    private adapters: {
      chat: Pick<AiProvider, 'chat'>
      embed: Pick<AiProvider, 'embed'>
      vision: Pick<AiProvider, 'vision'>
    },
  ) {}

  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult> {
    return this.adapters.chat.chat(messages, options)
  }

  embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    return this.adapters.embed.embed(texts, options)
  }

  vision(images: VisionImageInput[], prompt: string, options?: VisionOptions): Promise<VisionResult> {
    return this.adapters.vision.vision(images, prompt, options)
  }
}

export class TelemetryAiProvider implements AiProvider {
  constructor(
    private inner: AiProvider,
    private recorder?: TelemetryRecorder,
  ) {}

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult> {
    const start = Date.now()
    try {
      const result = await this.inner.chat(messages, options)
      const latencyMs = Date.now() - start
      this.recorder?.record({
        action: 'chat',
        model: result.model || options?.model,
        latencyMs,
        success: true,
        inputCount: messages.length,
        outputCount: result.content ? 1 : 0,
        usage: result.usage,
        metadata: { telemetryContext: options?.telemetryContext },
      })
      return result
    } catch (err: any) {
      const latencyMs = Date.now() - start
      this.recorder?.record({
        action: 'chat',
        model: options?.model,
        latencyMs,
        success: false,
        inputCount: messages.length,
        errorCode: err instanceof AiProviderError ? err.code : 'api_error',
        metadata: { telemetryContext: options?.telemetryContext },
      })
      throw err
    }
  }

  async embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    const start = Date.now()
    try {
      const result = await this.inner.embed(texts, options)
      const latencyMs = Date.now() - start
      this.recorder?.record({
        action: 'embed',
        model: options?.model,
        latencyMs,
        success: true,
        inputCount: texts.length,
        outputCount: result.length,
        metadata: { telemetryContext: options?.telemetryContext },
      })
      return result
    } catch (err: any) {
      const latencyMs = Date.now() - start
      this.recorder?.record({
        action: 'embed',
        model: options?.model,
        latencyMs,
        success: false,
        inputCount: texts.length,
        errorCode: err instanceof AiProviderError ? err.code : 'api_error',
        metadata: { telemetryContext: options?.telemetryContext },
      })
      throw err
    }
  }

  async vision(images: VisionImageInput[], prompt: string, options?: VisionOptions): Promise<VisionResult> {
    const start = Date.now()
    try {
      const result = await this.inner.vision(images, prompt, options)
      const latencyMs = Date.now() - start
      this.recorder?.record({
        action: 'vision',
        model: result.model || options?.model,
        latencyMs,
        success: true,
        inputCount: images.length,
        outputCount: result.content ? 1 : 0,
        metadata: { telemetryContext: options?.telemetryContext },
      })
      return result
    } catch (err: any) {
      const latencyMs = Date.now() - start
      this.recorder?.record({
        action: 'vision',
        model: options?.model,
        latencyMs,
        success: false,
        inputCount: images.length,
        errorCode: err instanceof AiProviderError ? err.code : 'api_error',
        metadata: { telemetryContext: options?.telemetryContext },
      })
      throw err
    }
  }
}

/**
 * Create a default AI provider composed of:
 *   - chat: DeepSeek
 *   - vision: Gemini
 *   - embed: local bge-m3 by default, or OpenAI when EMBEDDING_PROVIDER=openai
 */
export function createAiProvider(
  config?: Partial<AiProviderConfig>,
  recorder?: TelemetryRecorder,
): AiProvider {
  const cfg = { ...loadAiConfigFromEnv(), ...config }
  // #202: runtime provider selection — DEFAULT_LLM_PROVIDER env drives the
  // chat adapter (deepseek default, backward compatible).
  const chatProvider = resolveChatProvider(cfg)
  const visionProvider = new GeminiVisionProvider(cfg)
  let embedProvider: Pick<AiProvider, 'embed'>
  if (cfg.embeddingProvider === 'openai') {
    embedProvider = new OpenAIEmbeddingProvider(cfg)
  } else {
    const local = new LocalEmbeddingProvider(cfg)
    if (cfg.embeddingFallbackProvider === 'openai') {
      embedProvider = new ResilientEmbeddingProvider(local, new OpenAIEmbeddingProvider(cfg))
    } else {
      embedProvider = local
    }
  }

  const composite = new CompositeAiProvider({ chat: chatProvider, embed: embedProvider, vision: visionProvider })
  return new TelemetryAiProvider(composite, recorder)
}
