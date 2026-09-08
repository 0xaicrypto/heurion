/**
 * #921 — llm-gateway 拆分:共享类型与模块级状态。
 * 纯机械搬移自 src/common/llm-gateway.ts — 零行为变化。
 */
import { makeLogger } from '../logger.js'

export const log = makeLogger('llm-gateway')

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
  /** #fix 2026-09: 工具回合流式调用(chatWithToolsStream)返回 — finish_reason='tool_calls' 时的解析结果。 */
  toolCalls?: Array<{ name: string; arguments: string }>
  /**
   * #827: 多模态输出 — provider 在 message.images(OpenAI-compat 约定)或
   * content 内联 data-URI/https 图片时填充(data: 或 https:// URL)。
   * 普通文本响应恒为 undefined,既有消费方零影响。
   */
  images?: string[]
}

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

export interface LlmTelemetryContext {
  userId: string
  workspaceId: string
  action: string
}

export interface LlmTelemetryRecorder {
  record(input: {
    userId: string
    workspaceId: string
    /** #802: 'llm_error' — 失败/超时调用与 'llm_cost' 成功对称落库。 */
    category: 'llm_cost' | 'llm_error'
    action: string
    metadata: Record<string, unknown>
  }): Promise<void>
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
  /** OpenCode Go 要求 per-conversation 稳定会话 ID(x-opencode-session 头,
   *  用于路由与 prompt caching);生产 2026-09 起 Console Go 上游对缺失
   *  直接 400(MissingSessionID)。有会话上下文的调用方尽量传入。 */
  sessionId?: string
  /** @internal — pure-reasoning truncation retry guard (never set by callers). */
  retryDepth?: number
}

/** Historical alias kept for compatibility with pre-#436 call sites. */
export type DeepSeekCallOptions = LlmChatOptions

export interface LlmToolDefinition {
  type: string
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** @internal — OpenAI-compatible SSE/JSON chunk shape (chatWithMeta / streaming). */
export interface LlmChunk {
  choices?: Array<{ delta?: { content?: string; reasoning_content?: string; role?: string; tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }> }; message?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ type: string; function: { name: string; arguments: string } }> }; finish_reason?: string | null }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number }
}

let telemetryRecorder: LlmTelemetryRecorder | undefined

export function setLlmTelemetryService(service?: LlmTelemetryRecorder): void {
  telemetryRecorder = service
}

/** @internal — current telemetry recorder (used by recordUsage/recordFailure). */
export function getTelemetryRecorder(): LlmTelemetryRecorder | undefined {
  return telemetryRecorder
}
