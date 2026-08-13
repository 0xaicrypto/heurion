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
  DEEPSEEK_CHAT_MODEL,
  DEEPSEEK_PREMIUM_MODEL,
  setLlmTelemetryService,
  getLlmGateway,
  setLlmGatewayForTest,
} from './llm-gateway.js'
export { ChatMessage } from './llm-gateway.js'

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
