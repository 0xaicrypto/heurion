/**
 * #436 — Backward-compatible facade over the single LlmGateway.
 *
 * All implementation (retry / telemetry / pricing / provider registry) now
 * lives in `./llm-gateway.js`. These helpers keep their historical
 * signatures so existing call sites (~22) work unchanged; new code should
 * depend on `getLlmGateway()` (or these helpers) only.
 */
import { getLlmGateway } from './llm-gateway.js'
import type { ChatMessage, LlmChatOptions, LlmChatResult, LlmToolDefinition } from './llm-gateway.js'

export type DeepSeekCallOptions = LlmChatOptions
export {
  FRIENDLY_LLM_ERROR,
  LlmTelemetryContext,
  LlmTelemetryRecorder,
  LlmChatOptions,
  LlmToolDefinition,
  LlmEndpoint,
  LLM_PROVIDERS,
  resolveLlmEndpoint,
  LlmGateway,
  LlmChatResult,
  LlmTruncatedError,
  fetchWithRetry,
  resolveTurnTimeoutMs,
  setLlmTelemetryService,
  getLlmGateway,
  setLlmGatewayForTest,
} from './llm-gateway.js'
export { ChatMessage } from './llm-gateway.js'
// #925/#921: DEEPSEEK_CHAT_MODEL / DEEPSEEK_PREMIUM_MODEL 原是模块加载时
// 快照的 const(运行时改 env 不生效),拆分时改为惰性读取的函数。
export { resolveLegacyChatModel, resolveLegacyPremiumModel } from './llm-gateway.js'

/**
 * Non-streaming call — used for simple completions and tool calls.
 * `apiKey` is accepted for backward compatibility and ignored (the gateway
 * resolves the key from the active provider's env var).
 */
export async function deepseekChat(
  messages: ChatMessage[],
  _apiKey: string,
  options: DeepSeekCallOptions = {},
  tools?: LlmToolDefinition[],
  onReasoning?: (text: string) => void,
): Promise<string> {
  return getLlmGateway().chat(messages, options, tools, onReasoning)
}

/** #548 — non-streaming call that also reports truncation (finish_reason='length'). */
export async function deepseekChatWithMeta(
  messages: ChatMessage[],
  _apiKey: string,
  options: DeepSeekCallOptions = {},
  tools?: LlmToolDefinition[],
  onReasoning?: (text: string) => void,
): Promise<LlmChatResult> {
  return getLlmGateway().chatWithMeta(messages, options, tools, onReasoning)
}

/**
 * #fix 2026-09 — 工具回合流式调用(治中转站非流式的 CF ~100s 掐断/600s 超时):
 *  reasoning 实时回调(工具回合内思维链可见),返回与 chatWithMeta 同构
 *  (finish_reason='tool_calls' 时 text 为 tool_call 块拼接)。
 * `apiKey` is accepted for backward compatibility and ignored.
 */
export async function deepseekChatWithToolsStream(
  messages: ChatMessage[],
  _apiKey: string,
  options: DeepSeekCallOptions = {},
  tools?: LlmToolDefinition[],
  onReasoning?: (text: string) => void,
): Promise<LlmChatResult & { toolCalls?: Array<{ name: string; arguments: string }> }> {
  return getLlmGateway().chatWithToolsStream(messages, options, tools, onReasoning)
}

/**
 * Streaming call — yields chunks via AsyncGenerator.
 * `apiKey` is accepted for backward compatibility and ignored.
 */
export async function* deepseekStream(
  messages: ChatMessage[],
  _apiKey: string,
  options: DeepSeekCallOptions = {},
  onReasoning?: (text: string) => void,
): AsyncGenerator<string> {
  yield* getLlmGateway().stream(messages, options, onReasoning)
}

export function getApiKey(): string {
  return getLlmGateway().getApiKey()
}
