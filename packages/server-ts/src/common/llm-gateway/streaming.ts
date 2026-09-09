/**
 * #921 — llm-gateway 拆分:流式调用(SSE 解析 / 工具回合流 / 截断重试)。
 * 纯机械搬移自 src/common/llm-gateway.ts 的 OpenAICompatibleLlmGateway
 * .chatWithToolsStream / .stream 方法体 — 零行为变化(类方法委托到这里的
 * 自由函数,递归同样直达 impl,与原 this.X() 递归等价)。
 */
import { log, LlmTruncatedError, type ChatMessage, type LlmChatOptions, type LlmToolDefinition, type LlmChatResult, type LlmChunk } from './types.js'
import { resolveDefaultMaxTokens, truncationRetryBudget, MAX_TRUNCATION_RETRY_DEPTH, resolveRequestModel, resolveLlmEndpoint, resolveLegacyChatModel, resolveLegacyPremiumModel } from './provider.js'
import { fetchWithRetry, withBodyIdleTimeout, buildRequestHeaders } from './http.js'
import { recordUsage, recordFailure, approximateTokensFromChars, promptChars } from './pricing.js'
import { serializeMessages, stripImageParts, isImageUnsupportedError } from './vision.js'

/**
 * #fix 2026-09 — 工具回合流式调用(治中转站模式非流式的结构性缺陷):
 *  非流式在工具回合是零字节直到完整生成 — 整篇重写类大任务的
 *  thinking+工具参数生成 5-10 分钟,中转层 Cloudflare ~100s 无字节即掐断
 *  ("fetch failed"),本地 TTFB 超时再掐死("LLM request timed out")。
 *  流式让字节持续流动,空闲超时语义才正确;reasoning 实时回调
 *  (工具回合内思维链对用户可见)。
 *  返回与 chatWithMeta 同构: finish_reason='tool_calls' 时 text 为
 *  tool_call 块拼接(消费方零逻辑变更)。
 */
export async function chatWithToolsStreamImpl(
  messages: ChatMessage[],
  options: LlmChatOptions = {},
  tools?: LlmToolDefinition[],
  onReasoning?: (text: string) => void,
): Promise<LlmChatResult & { toolCalls?: Array<{ name: string; arguments: string }> }> {
  const model = resolveRequestModel(options, resolveLegacyChatModel())
  const startedAt = Date.now()
  const body: any = {
    model,
    messages: serializeMessages(messages, model),
    max_tokens: options.maxTokens ?? resolveDefaultMaxTokens(model),
    temperature: options.temperature ?? 0.7,
    stream: true,
    stream_options: { include_usage: true },
    // #752: GLM 混合思考开关(仅 glm-* 生效)
    ...(options.thinking && model.toLowerCase().startsWith('glm') ? { thinking: { type: options.thinking } } : {}),
  }
  if (tools && tools.length > 0) {
    body.tools = tools
    body.tool_choice = 'auto'
  }
  let res: Awaited<ReturnType<typeof fetch>>
  try {
    res = await fetchWithRetry(`${resolveLlmEndpoint().baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildRequestHeaders(options),
      body: JSON.stringify(body),
    }, { signal: options.signal, timeoutMs: options.timeoutMs })
  } catch (err) {
    await recordFailure(model, options, err, promptChars(messages), Date.now() - startedAt)
    throw err
  }
  log.info(`[LLM] tools-stream headers=${Date.now() - startedAt}ms model=${model}`)
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    // #fix 2026-09: 图片被纯文本上游拒收 → 剥离重试一次(同 chatWithMeta)。
    if (isImageUnsupportedError(res.status, errBody)) {
      log.warn('image parts rejected (tools stream) — retrying with images stripped', { model })
      const stripped: any = { ...body, messages: serializeMessages(stripImageParts(messages), model) }
      const res2 = await fetchWithRetry(`${resolveLlmEndpoint().baseUrl}/chat/completions`, {
        method: 'POST',
        headers: buildRequestHeaders(options),
        body: JSON.stringify(stripped),
      }, { signal: options.signal, timeoutMs: options.timeoutMs })
      if (!res2.ok) {
        const body2 = await res2.text().catch(() => '')
        await recordFailure(model, options, new Error(`HTTP ${res2.status} after image-strip retry: ${body2.slice(0, 200)}`), promptChars(messages), Date.now() - startedAt)
        throw new Error(`LLM 请求失败 (HTTP ${res2.status}): ${body2.slice(0, 300)}`)
      }
      res = res2
    } else {
      await recordFailure(model, options, new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`), promptChars(messages), Date.now() - startedAt)
      throw new Error(`LLM 请求失败 (HTTP ${res.status}): ${errBody.slice(0, 300)}`)
    }
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let finishReason: string | null = null
  let finalUsage: LlmChunk['usage'] | undefined
  let completionChars = 0
  let ttfbLogged = false
  const toolAcc = new Map<number, { id?: string; name: string; arguments: string }>()

  try {
    while (true) {
      let readResult: Awaited<ReturnType<typeof reader.read>>
      try {
        readResult = await withBodyIdleTimeout(reader.read(), 'LLM stream stalled')
      } catch (err) {
        try { await reader.cancel() } catch { /* already broken */ }
        throw err
      }
      const { done, value } = readResult
      if (done) break
      if (!ttfbLogged && value.length > 0) {
        ttfbLogged = true
        log.info(`[LLM] tools-stream ttfb=${Date.now() - startedAt}ms model=${model}`)
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue
        try {
          const chunk: LlmChunk = JSON.parse(data)
          if (chunk.usage) { finalUsage = chunk.usage; continue }
          const choice = chunk.choices?.[0]
          if (choice?.finish_reason) finishReason = choice.finish_reason
          const delta = choice?.delta
          if (delta?.reasoning_content) onReasoning?.(delta.reasoning_content)
          if (delta?.content) { text += delta.content; completionChars += delta.content.length }
          for (const tc of delta?.tool_calls ?? []) {
            const idx = typeof tc.index === 'number' ? tc.index : toolAcc.size
            const cur = toolAcc.get(idx) ?? { name: '', arguments: '' }
            if (tc.id) cur.id = tc.id
            if (tc.function?.name) cur.name = tc.function.name
            if (tc.function?.arguments) cur.arguments += tc.function.arguments
            toolAcc.set(idx, cur)
          }
        } catch { /* skip parse errors */ }
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (finalUsage && typeof finalUsage.prompt_tokens === 'number' && typeof finalUsage.completion_tokens === 'number') {
    await recordUsage(model, options, finalUsage.prompt_tokens, finalUsage.completion_tokens, finalUsage.prompt_cache_hit_tokens || 0, finalUsage.prompt_cache_miss_tokens || 0)
  } else {
    await recordUsage(model, options, approximateTokensFromChars(promptChars(messages)), approximateTokensFromChars(completionChars))
  }

  const parsedToolCalls: Array<{ name: string; arguments: string }> = []
  // #fix 2026-09-09: 只要流里累积到了工具调用就转换 — 此前要求
  // finish_reason==='tool_calls',而 GLM 经 opencode 中转站发
  // delta.tool_calls 时 finish_reason 常为 null/stop(生产实证:模型逐条
  // 发出 12 个 edit_document 调用全被此门丢弃,tool-loop 只看到引导语,
  // 用户看到纯文本计划)。判定以「流中出现过工具调用增量」为准。
  if (toolAcc.size > 0) {
    // tool_call 标签用 unicode 转义构造 — 与 parseChatResponse 的块格式
    // 完全一致,tool-loop 的块解析零变更。
    const OPEN = '\u003ctool_call\u003e'
    const CLOSE = '\u003c/tool_call\u003e'
    const blocks: string[] = []
    for (const tc of toolAcc.values()) {
      if (!tc.name) continue
      let args: unknown
      try { args = JSON.parse(tc.arguments || '{}') } catch { args = { _raw: tc.arguments } }
      blocks.push(`${OPEN}${JSON.stringify({ name: tc.name, arguments: args })}${CLOSE}`)
      parsedToolCalls.push({ name: tc.name, arguments: tc.arguments || '{}' })
    }
    if (blocks.length > 0) {
      // 保留引导语正文(模型常在工具调用前输出一句话说明)— 拼在块前,
      // tool-loop 的块解析与最终文本清洗(:488 剥离工具标记)兼容。
      const leadIn = text.trim() ? `${text.trim()}\n` : ''
      return { text: leadIn + blocks.join('\n'), truncated: false, toolCalls: parsedToolCalls }
    }
  }
  if (finishReason === 'length') {
    const retryDepth = options.retryDepth ?? 0
    if (!text.trim() && retryDepth < MAX_TRUNCATION_RETRY_DEPTH) {
      return await chatWithToolsStreamImpl(
        messages,
        { ...options, maxTokens: truncationRetryBudget(model, options.maxTokens), retryDepth: retryDepth + 1 },
        tools,
        onReasoning,
      )
    }
  }
  return { text, truncated: finishReason === 'length', toolCalls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined }
}

export async function* streamImpl(
  messages: ChatMessage[],
  options: LlmChatOptions = {},
  onReasoning?: (text: string) => void,
): AsyncGenerator<string> {
  const model = resolveRequestModel(options, resolveLegacyPremiumModel())
  const startedAt = Date.now()
  let res: Awaited<ReturnType<typeof fetch>>
  try {
    res = await fetchWithRetry(`${resolveLlmEndpoint().baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildRequestHeaders(options),
      body: JSON.stringify({
        model,
        messages: serializeMessages(messages, model),
        max_tokens: options.maxTokens ?? resolveDefaultMaxTokens(model),
        temperature: options.temperature ?? 0.7,
        stream: true,
        stream_options: { include_usage: true },
        // #752: GLM 混合思考开关(同 chatWithMeta — 仅 glm-* 生效)
        ...(options.thinking && model.toLowerCase().startsWith('glm')
          ? { thinking: { type: options.thinking } }
          : {}),
      }),
    }, { signal: options.signal, timeoutMs: options.timeoutMs })
  } catch (err) {
    // #802: 流式路径同样对称记录失败(超时=上游连响应头都没给)。
    await recordFailure(model, options, err, promptChars(messages), Date.now() - startedAt)
    throw err
  }
  if (!res.ok) {
    // 同上 — 流式路径也带状态码 + 上游响应体片段。
    const body = await res.text().catch(() => '')
    // #fix 2026-09: 图片被纯文本上游拒收 → 剥离重试一次(同 chatWithMeta)。
    // 流式尚未产出任何字节,重试对调用方透明。
    if (isImageUnsupportedError(res.status, body)) {
      log.warn('image parts rejected (stream) — retrying with images stripped', { model })
      const bodyJson: any = {
        model,
        messages: serializeMessages(stripImageParts(messages), model),
        max_tokens: options.maxTokens ?? resolveDefaultMaxTokens(model),
        temperature: options.temperature ?? 0.7,
        stream: true,
        stream_options: { include_usage: true },
        ...(options.thinking && model.toLowerCase().startsWith('glm') ? { thinking: { type: options.thinking } } : {}),
      }
      const res2 = await fetchWithRetry(`${resolveLlmEndpoint().baseUrl}/chat/completions`, {
        method: 'POST',
        headers: buildRequestHeaders(options),
        body: JSON.stringify(bodyJson),
      }, { signal: options.signal, timeoutMs: options.timeoutMs })
      if (res2.ok) {
        res = res2
      } else {
        const body2 = await res2.text().catch(() => '')
        await recordFailure(model, options, new Error(`HTTP ${res2.status} after image-strip retry: ${body2.slice(0, 200)}`), promptChars(messages), Date.now() - startedAt)
        throw new Error(`LLM 请求失败 (HTTP ${res2.status}): ${body2.slice(0, 300)}`)
      }
    } else {
      await recordFailure(model, options, new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`), promptChars(messages), Date.now() - startedAt)
      throw new Error(`LLM 请求失败 (HTTP ${res.status}): ${body.slice(0, 300)}`)
    }
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completionChars = 0
  let finalUsage: LlmChunk['usage'] | undefined
  let truncated = false
  // #548: reasoning vs content tracking — a truncation BEFORE any visible
  // content means the reasoner burned the budget thinking; the stream must
  // not end silently with zero output.
  let sawContent = false
  let sawReasoning = false
  // #fix: TTFB 观测 — 首字节耗时是"上游排队 vs 任务本身重"的判据。
  let ttfbLogged = false

  try {
    while (true) {
      // #828: per-read idle timeout — a stalled provider after headers
      // must surface as an error, not an eternal await. The timer resets
      // on every chunk because each read gets its own race.
      let readResult: Awaited<ReturnType<typeof reader.read>>
      try {
        readResult = await withBodyIdleTimeout(reader.read(), 'LLM stream stalled')
      } catch (err) {
        try { await reader.cancel() } catch { /* already broken */ }
        throw err
      }
      const { done, value } = readResult
      if (done) break
      if (!ttfbLogged && value.length > 0) {
        ttfbLogged = true
        log.info(`[LLM] ttfb=${Date.now() - startedAt}ms model=${model}`)
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        // #548: the provider signals the end of the stream right after a
        // finish_reason='length' chunk — throw before completing so the
        // caller can surface the truncation notice.
        if (data === '[DONE]') {
          if (truncated) break
          return
        }
        try {
          const chunk: LlmChunk = JSON.parse(data)
          if (chunk.usage) {
            finalUsage = chunk.usage
            continue
          }
          const choice = chunk.choices?.[0]
          const delta = choice?.delta
          const reasoningContent = delta?.reasoning_content
          if (reasoningContent) {
            sawReasoning = true
            if (onReasoning) onReasoning(reasoningContent)
          }
          const content = delta?.content
          if (content) {
            sawContent = true
            completionChars += content.length
            yield content
          }
          // #548: detect finish_reason='length' so the caller can surface
          // a truncation notice instead of marking a half reply complete.
          if (choice?.finish_reason === 'length') {
            truncated = true
            break
          }
        } catch { /* skip parse errors */ }
      }
      if (truncated) break
    }
  } finally {
    reader.releaseLock()
  }

  if (finalUsage && typeof finalUsage.prompt_tokens === 'number' && typeof finalUsage.completion_tokens === 'number') {
    await recordUsage(model, options, finalUsage.prompt_tokens, finalUsage.completion_tokens, finalUsage.prompt_cache_hit_tokens || 0, finalUsage.prompt_cache_miss_tokens || 0)
  } else {
    const pTokens = approximateTokensFromChars(promptChars(messages))
    const cTokens = approximateTokensFromChars(completionChars)
    await recordUsage(model, options, pTokens, cTokens)
  }

  if (truncated) {
    // #548: nothing visible was produced — the whole budget went to
    // thinking. Retry ONCE with a doubled budget; only give up (with the
    // trimming metadata) when the retry also fails.
    const retryDepth = options.retryDepth ?? 0
    if (!sawContent && retryDepth < MAX_TRUNCATION_RETRY_DEPTH) {
      try {
        yield* streamImpl(
          messages,
          {
            ...options,
            maxTokens: truncationRetryBudget(model, options.maxTokens),
            retryDepth: retryDepth + 1,
          },
          onReasoning,
        )
        return
      } catch (err) {
        if (err instanceof LlmTruncatedError) {
          throw new LlmTruncatedError({ hadContent: false, hadReasoning: sawReasoning || err.hadReasoning })
        }
        throw err
      }
    }
    throw new LlmTruncatedError({ hadContent: sawContent, hadReasoning: sawReasoning })
  }
}
