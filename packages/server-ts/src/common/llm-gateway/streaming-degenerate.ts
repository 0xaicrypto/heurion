/**
 * #979/#1127 — 流式工具调用退化的非流式重取。
 *
 * 上游中转的流式通道会丢 tool_calls 参数（全丢:480 个增量 argFrags=0B;
 * 部分丢:并行调用中单个调用参数为空），服务端无法从空流恢复。流式保住
 * TTFB/心跳价值，退化时换非流式一次（非流式 tool_calls 参数完整，
 * doc-executor 兜底的生产实证）。从 streaming.ts 拆出（P2 大文件棘轮）。
 */
import type { ChatMessage, LlmChatOptions, LlmChatResult, LlmChunk, LlmToolDefinition } from './types.js'
import { resolveRequestModel, resolveLlmEndpoint, resolveLegacyChatModel, resolveDefaultMaxTokens } from './provider.js'
import { fetchWithRetry, withBodyIdleTimeout, buildRequestHeaders } from './http.js'
import { recordUsage } from './pricing.js'
import { serializeMessages } from './vision.js'

export async function degenerateNonStreamRetry(
  messages: ChatMessage[],
  options: LlmChatOptions,
  tools?: LlmToolDefinition[],
  onReasoning?: (text: string) => void,
): Promise<LlmChatResult> {
  const model = resolveRequestModel(options, resolveLegacyChatModel())
  const body: Record<string, unknown> = {
    model,
    messages: serializeMessages(messages, model),
    max_tokens: options.maxTokens ?? resolveDefaultMaxTokens(model),
    temperature: options.temperature ?? 0.7,
    ...(options.thinking && model.toLowerCase().startsWith('glm') ? { thinking: { type: options.thinking } } : {}),
  }
  if (tools && tools.length > 0) {
    body.tools = tools
    body.tool_choice = 'auto'
  }
  const res = await fetchWithRetry(`${resolveLlmEndpoint().baseUrl}/chat/completions`, {
    method: 'POST',
    headers: buildRequestHeaders(options),
    body: JSON.stringify(body),
  }, { signal: options.signal, timeoutMs: options.timeoutMs })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 160)}`)
  }
  const json = (await withBodyIdleTimeout(res.json(), 'LLM non-stream fallback body stalled')) as LlmChunk
  const choice = json?.choices?.[0]
  const reasoning = choice?.message?.reasoning_content
  if (reasoning && onReasoning) onReasoning(reasoning)
  const usage = json?.usage
  if (usage && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number') {
    await recordUsage(model, options, usage.prompt_tokens, usage.completion_tokens, usage.prompt_cache_hit_tokens || 0, usage.prompt_cache_miss_tokens || 0)
  }
  // tool_calls → 块格式（与 parseChatResponse 同构）
  if (choice?.message?.tool_calls?.length) {
    const OPEN = '\u003ctool_call\u003e'
    const CLOSE = '\u003c/tool_call\u003e'
    const blocks: string[] = []
    for (const tc of choice.message.tool_calls) {
      if (tc.type !== 'function') continue
      let args: unknown
      try { args = JSON.parse(tc.function.arguments || '{}') } catch { args = { _raw: tc.function.arguments } }
      blocks.push(`${OPEN}${JSON.stringify({ name: tc.function.name, arguments: args })}${CLOSE}`)
    }
    if (blocks.length > 0) {
      const leadIn = (choice.message.content || '').trim()
      return { text: (leadIn ? leadIn + '\n' : '') + blocks.join('\n'), truncated: false }
    }
  }
  return { text: choice?.message?.content || '', truncated: choice?.finish_reason === 'length' }
}
