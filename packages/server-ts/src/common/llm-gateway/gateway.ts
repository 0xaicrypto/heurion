/**
 * #921 — llm-gateway 拆分:网关类(接口 + OpenAI 兼容实现 + 进程级单例)。
 * 纯机械搬移自 src/common/llm-gateway.ts — 零行为变化。
 * 非流式(chatWithMeta/parseChatResponse/generateImage)保留为类方法;
 * 流式两条路径委托 streaming.ts 的自由函数实现(与原 this.X() 递归等价)。
 * 原 endpoint/getApiKey/headers/resolveModel 私有方法体移至
 * provider/http 的自由函数(resolveApiKey/buildRequestHeaders/
 * resolveRequestModel),类方法薄委托,语义逐行不变。
 */
import type {
  ChatMessage,
  LlmChatOptions,
  LlmChatResult,
  LlmChunk,
  LlmToolDefinition,
} from './types.js'
import { log } from './types.js'
import {
  currentLlmProvider,
  resolveActiveModel,
  resolveApiKey,
  resolveDefaultMaxTokens,
  resolveLegacyChatModel,
  resolveLlmEndpoint,
  resolveRequestModel,
  truncationRetryBudget,
  MAX_TRUNCATION_RETRY_DEPTH,
} from './provider.js'
import { fetchWithRetry, withBodyIdleTimeout, buildRequestHeaders } from './http.js'
import { recordFailure, recordUsage, approximateTokensFromChars, promptChars } from './pricing.js'
import {
  serializeMessages,
  stripImageParts,
  isImageUnsupportedError,
  extractImagesFromChatResponse,
  providerSupportsVision,
} from './vision.js'
import { chatWithToolsStreamImpl, streamImpl } from './streaming.js'

export interface LlmGateway {
  /** Non-streaming call — simple completions and tool calls. */
  chat(
    messages: ChatMessage[],
    options?: LlmChatOptions,
    tools?: LlmToolDefinition[],
    onReasoning?: (text: string) => void,
  ): Promise<string>
  /** #548 — non-streaming call with truncation metadata. */
  chatWithMeta(
    messages: ChatMessage[],
    options?: LlmChatOptions,
    tools?: LlmToolDefinition[],
    onReasoning?: (text: string) => void,
  ): Promise<LlmChatResult>
  /** Streaming call — yields content deltas via AsyncGenerator. */
  stream(messages: ChatMessage[], options?: LlmChatOptions, onReasoning?: (text: string) => void): AsyncGenerator<string>
  /** #fix 2026-09: 工具回合流式调用 — 非流式在中转站模式被 CF ~100s 掐断。 */
  chatWithToolsStream(
    messages: ChatMessage[],
    options?: LlmChatOptions,
    tools?: LlmToolDefinition[],
    onReasoning?: (text: string) => void,
  ): Promise<LlmChatResult & { toolCalls?: Array<{ name: string; arguments: string }> }>
  /** API key for the active provider (from the provider's env var). */
  getApiKey(): string
  generateImage(prompt: string, options?: LlmChatOptions): Promise<{ dataBase64: string; mime: string }>
}

/**
 * Default implementation: OpenAI-compatible Chat Completions client.
 * Provider (base URL + key env + model env) resolved from
 * DEFAULT_LLM_PROVIDER via the registry.
 */
export class OpenAICompatibleLlmGateway implements LlmGateway {
  // Endpoint is resolved per-call (env may change at runtime / tests) —
  // see resolveLlmEndpoint / resolveApiKey / buildRequestHeaders.

  getApiKey(): string {
    // Hard-coded keys are forbidden — the key MUST come from the environment.
    return resolveApiKey()
  }

  /** Model resolution: explicit option > admin override > provider modelEnv
   *  > legacy default. */
  private resolveModel(options: LlmChatOptions, legacyDefault: string): string {
    return resolveRequestModel(options, legacyDefault)
  }

  /** 统一请求头(OpenCode Go 会话头/UA) — http.buildRequestHeaders。 */
  private headers(options: LlmChatOptions): Record<string, string> {
    return buildRequestHeaders(options)
  }

  async chat(
    messages: ChatMessage[],
    options: LlmChatOptions = {},
    tools?: LlmToolDefinition[],
    onReasoning?: (text: string) => void,
  ): Promise<string> {
    return (await this.chatWithMeta(messages, options, tools, onReasoning)).text
  }

  async chatWithMeta(
    messages: ChatMessage[],
    options: LlmChatOptions = {},
    tools?: LlmToolDefinition[],
    onReasoning?: (text: string) => void,
  ): Promise<LlmChatResult> {
    const model = this.resolveModel(options, resolveLegacyChatModel())
    const body: any = {
      model,
      messages: serializeMessages(messages, model),
      max_tokens: options.maxTokens ?? resolveDefaultMaxTokens(model),
      temperature: options.temperature ?? 0.7,
    }
    // #752: GLM 混合思考 — thinking 参数仅 glm-* 模型接受,其他 provider
    // 不传该字段避免 400。
    if (options.thinking && model.toLowerCase().startsWith('glm')) {
      body.thinking = { type: options.thinking }
    }
    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    const startedAt = Date.now()
    let res: Awaited<ReturnType<typeof fetch>>
    try {
      res = await fetchWithRetry(`${resolveLlmEndpoint().baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(options),
        body: JSON.stringify(body),
      }, { signal: options.signal, timeoutMs: options.timeoutMs })
    } catch (err) {
      // #802: 超时/网络失败 — 与成功对称落 [LLM] failed + telemetry llm_error。
      await recordFailure(model, options, err, promptChars(messages), Date.now() - startedAt)
      throw err
    }
    log.info(`[LLM] headers=${Date.now() - startedAt}ms model=${model}`)
    if (!res.ok) {
      // 上游明确拒绝(401 key 失效 / 402 余额 / 429 限流 / 413 超长) —
      // 带状态码 + 上游响应体片段,前端/日志可定位真实原因(如某模型
      // 不支持 tools/image 参数时上游会写明)。
      const errBody = await res.text().catch(() => '')
      // #fix 2026-09: 中转站/上游纯文本模型拒收 image_url(生产 400:
      // "Model only supports text input") — 注册表可能落后于中转实际路由。
      // 剥离图片为文字占位重试一次,回合不再因这类错误整轮报废。
      if (isImageUnsupportedError(res.status, errBody)) {
        log.warn('image parts rejected — retrying with images stripped', { model })
        const res2 = await fetchWithRetry(`${resolveLlmEndpoint().baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.headers(options),
          body: JSON.stringify({ ...body, messages: serializeMessages(stripImageParts(messages), model) }),
        }, { signal: options.signal, timeoutMs: options.timeoutMs })
        if (res2.ok) {
          return this.parseChatResponse(await withBodyIdleTimeout(res2.json(), 'LLM response body stalled'), model, options, messages, tools, onReasoning)
        }
        const body2 = await res2.text().catch(() => '')
        await recordFailure(model, options, new Error(`HTTP ${res2.status} after image-strip retry: ${body2.slice(0, 200)}`), promptChars(messages), Date.now() - startedAt)
        throw new Error(`LLM 请求失败 (HTTP ${res2.status}): ${body2.slice(0, 300)}`)
      }
      await recordFailure(model, options, new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`), promptChars(messages), Date.now() - startedAt)
      throw new Error(`LLM 请求失败 (HTTP ${res.status}): ${errBody.slice(0, 300)}`)
    }
    const json: { choices?: LlmChunk['choices']; usage?: LlmChunk['usage'] } = await withBodyIdleTimeout(res.json(), 'LLM response body stalled')
    return await this.parseChatResponse(json, model, options, messages, tools, onReasoning)
  }

  /** #fix 2026-09: 响应解析单点 — 供正常路径与图片剥离重试路径共用。 */
  private async parseChatResponse(
    json: { choices?: LlmChunk['choices']; usage?: LlmChunk['usage'] },
    model: string,
    options: LlmChatOptions,
    messages: ChatMessage[],
    tools?: LlmToolDefinition[],
    onReasoning?: (text: string) => void,
  ): Promise<LlmChatResult> {
    const choice = json.choices?.[0]

    // Surface the model's reasoning_content (deepseek-reasoner / v4-pro)
    // to callers that want to display the thinking process live.
    const reasoning = choice?.message?.reasoning_content
    if (reasoning && onReasoning) {
      onReasoning(reasoning)
    }

    // Handle tool_calls
    // #fix 2026-09-09: 对齐流式孪生 — 只要 message.tool_calls 存在就转换,
    // 不再要求 finish_reason==='tool_calls'(GLM 经中转站常以 stop/null 收尾,
    // 12 个 edit_document 调用曾因此被整体丢弃)。
    if (choice?.message?.tool_calls?.length) {
      const blocks: string[] = []
      for (const tc of choice.message.tool_calls) {
        if (tc.type === 'function') {
          // #911: 对齐流式孪生(chatWithToolsStream)口径 — arguments 坏 JSON
          // 降级 { _raw } 不抛,单个坏工具调用不再炸掉整轮响应解析。
          let args: unknown
          try { args = JSON.parse(tc.function.arguments || '{}') } catch { args = { _raw: tc.function.arguments } }
          blocks.push(`<tool_call>${JSON.stringify({ name: tc.function.name, arguments: args })}</tool_call>`)
        }
      }
      if (blocks.length > 0) {
        // 保留引导语正文(模型常在工具调用前输出一句话说明),拼在块前。
        const leadIn = (choice.message.content || '').trim()
        return { text: (leadIn ? leadIn + '\n' : '') + blocks.join('\n'), truncated: false }
      }
    }

    // #548: surface finish_reason='length' so callers can tell the user the
    // answer was cut off instead of silently presenting a half reply.
    const truncated = choice?.finish_reason === 'length'
    const content = choice?.message?.content || ''

    const usage = json?.usage
    if (usage && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number') {
      await recordUsage(model, options, usage.prompt_tokens, usage.completion_tokens, usage.prompt_cache_hit_tokens || 0, usage.prompt_cache_miss_tokens || 0)
    } else {
      const pTokens = approximateTokensFromChars(promptChars(messages))
      const cTokens = approximateTokensFromChars(content.length)
      await recordUsage(model, options, pTokens, cTokens)
    }

    // #548: truncated with ZERO visible content = the reasoner burned the
    // whole budget thinking. Retry ONCE with a doubled budget so the user
    // always receives an actual answer. Partial-content truncations and
    // failed retries are returned as-is (caller surfaces the notice).
    const retryDepth = options.retryDepth ?? 0
    if (truncated && !content.trim() && retryDepth < MAX_TRUNCATION_RETRY_DEPTH) {
      return await this.chatWithMeta(
        messages,
        {
          ...options,
          maxTokens: truncationRetryBudget(model, options.maxTokens),
          retryDepth: retryDepth + 1,
        },
        tools,
        onReasoning,
      )
    }

    return { text: content, truncated, images: extractImagesFromChatResponse(choice?.message) }
  }

  /**
   * #827 — 用当前主模型直接生成图像(取代独立图像 API 配置)。
   * 主模型非多模态 → IMAGE_UNSUPPORTED 明确报错;多模态但上游未返回
   * 图片(该模型不支持图像输出)→ 同样明确报错,绝不静默降级。
   */
  async generateImage(prompt: string, options: LlmChatOptions = {}): Promise<{ dataBase64: string; mime: string }> {
    const model = this.resolveModel(options, resolveActiveModel())
    if (!providerSupportsVision(currentLlmProvider(), model)) {
      throw new Error(`IMAGE_UNSUPPORTED: 主模型 ${model} 非多模态,无法生成图片 — 请在设置页切换到多模态模型`)
    }
    const result = await this.chatWithMeta(
      [{ role: 'user', content: `请直接生成一张图片并输出图片本身(不要只输出文字描述):${prompt}` }],
      { ...options, maxTokens: options.maxTokens ?? 4096 },
    )
    const urls = result.images || []
    const pick = urls.find((u) => u.startsWith('data:')) || urls[0]
    if (!pick) {
      throw new Error(`IMAGE_UNSUPPORTED: 模型 ${model} 未返回图片数据(该模型不支持图像生成)`)
    }
    if (pick.startsWith('data:')) {
      const m = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(pick)
      if (!m) throw new Error('IMAGE_UNSUPPORTED: 模型返回的图片数据无法解析')
      return { mime: m[1], dataBase64: m[2] }
    }
    // provider 返回的 https 图片 URL — 拉回转 base64(下游统一按字节落盘)
    const r = await fetch(pick, { signal: options.signal ?? AbortSignal.timeout(30_000) })
    if (!r.ok) throw new Error(`IMAGE_FAILED: 图片下载失败 HTTP ${r.status}`)
    const buf = Buffer.from(await r.arrayBuffer())
    return { mime: r.headers.get('content-type') || 'image/png', dataBase64: buf.toString('base64') }
  }

  /**
   * #fix 2026-09 — 工具回合流式调用(治中转站模式非流式的结构性缺陷):
   * 非流式在工具回合是零字节直到完整生成,中转层 CF ~100s 无字节即掐断。
   * #921 拆分:实现移至 streaming.chatWithToolsStreamImpl(零行为变化,
   * 原方法内 this.X() 递归在 impl 内直达自身,语义等价)。
   */
  async chatWithToolsStream(
    messages: ChatMessage[],
    options: LlmChatOptions = {},
    tools?: LlmToolDefinition[],
    onReasoning?: (text: string) => void,
  ): Promise<LlmChatResult & { toolCalls?: Array<{ name: string; arguments: string }> }> {
    return chatWithToolsStreamImpl(messages, options, tools, onReasoning)
  }

  /** Streaming call — #921 拆分:实现移至 streaming.streamImpl(零行为变化)。 */
  async *stream(
    messages: ChatMessage[],
    options: LlmChatOptions = {},
    onReasoning?: (text: string) => void,
  ): AsyncGenerator<string> {
    yield* streamImpl(messages, options, onReasoning)
  }
}

let gateway: LlmGateway | null = null

/** Get the process-wide LlmGateway (lazily initialized, env-read at first use). */
export function getLlmGateway(): LlmGateway {
  if (!gateway) gateway = new OpenAICompatibleLlmGateway()
  return gateway
}

/** Test hook: replace the gateway (e.g. with a mock). */
export function setLlmGatewayForTest(g: LlmGateway | null): void {
  gateway = g
}
