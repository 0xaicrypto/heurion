/**
 * #921 — llm-gateway 拆分:HTTP 层(超时/重试/请求头)。
 * 纯机械搬移自 src/common/llm-gateway.ts — 零行为变化。
 */
import { currentLlmProvider, resolveApiKey } from './provider.js'
import type { LlmChatOptions } from './types.js'

export const FRIENDLY_LLM_ERROR = '服务暂时不可用，请稍后重试'

/** #627 — LLM request timeout (TTFB) with env override LLM_TIMEOUT_MS.
 *  Default 300s: reasoning models on long documents (editing/polishing,
 *  chart generation with full doc context) can think >180s before the
 *  first token — the previous 180s aborted those with "LLM request timed
 *  out after 180000ms". The SSE heartbeat keeps the client connection
 *  alive while the origin waits. */
function resolveLlmTimeoutMs(): number {
  const fromEnv = parseInt(process.env.LLM_TIMEOUT_MS || '', 10)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  return 300000
}

/**
 * #828 — post-header stall protection. fetchWithRetry's timer covers TTFB
 * (response headers) only; after that, a non-streaming `res.json()` or a
 * streaming `reader.read()` could previously wait FOREVER when the
 * provider/relay sent headers early then stalled — and the SSE heartbeat
 * kept the client connection alive, so the turn looked "stuck" with no
 * error. Every body-read now races an idle timeout (LLM_BODY_IDLE_TIMEOUT_MS
 * env, default 120s) that raises an actionable error instead.
 */
function resolveBodyIdleTimeoutMs(): number {
  const fromEnv = parseInt(process.env.LLM_BODY_IDLE_TIMEOUT_MS || '', 10)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  return 120_000
}

export async function withBodyIdleTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  const idleMs = resolveBodyIdleTimeoutMs()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no data for ${idleMs}ms (post-header stall)`)), idleMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([p, timeoutP])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * #184 — fetch with timeout + retry (429/5xx, exponential backoff honoring
 * Retry-After). Timeouts and network failures raise friendly errors instead
 * of raw strings.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { maxRetries?: number; timeoutMs?: number; delayMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 2
  const timeoutMs = opts.timeoutMs ?? resolveLlmTimeoutMs()
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let controller: AbortController | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      controller = new AbortController()
      timer = setTimeout(() => controller!.abort(), timeoutMs)
      const signal = opts.signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([opts.signal, controller.signal])
        : controller.signal
      const res = await fetch(url, { ...init, signal })
      if (timer) clearTimeout(timer)
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`)
        if (attempt < maxRetries) {
          const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10)
          const delay = opts.delayMs ?? ((retryAfter || Math.pow(2, attempt)) * 1000)
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
        throw lastErr
      }
      return res
    } catch (err: any) {
      if (timer) clearTimeout(timer)
      lastErr = err
      if (err?.name === 'AbortError') {
        // #fix: 超时错误人话化 — 原样英文技术文案对用户不可行动。
        throw new Error(`AI 生成超时（${Math.round(timeoutMs / 1000)} 秒无响应）— 长任务可能超出单次生成上限，请拆分步骤后重试；若持续出现请稍后再试（上游服务可能繁忙）`)
      }
      if (attempt < maxRetries) {
        const delay = opts.delayMs ?? Math.pow(2, attempt) * 500
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }
  // 重试耗尽 — 保留具体失败原因(HTTP 状态/超时),前端才能给出可行动的
  // 提示,而不是一律吞成"服务暂时不可用"(用户无法区分 key 失效/限流/网络)。
  if (lastErr) throw lastErr
  throw new Error(FRIENDLY_LLM_ERROR)
}

/**
 * #fix 2026-09 — 统一请求头。OpenCode Go 网关除鉴权外还要求:
 *  1. 自报 UA(不能是泛用 SDK/HTTP 库名,否则可能被判为非编码代理流量);
 *  2. `x-opencode-session` 稳定会话 ID — 缺失时 Console Go 上游直接
 *     HTTP 400 MissingSessionID(生产 48h 内 18 次,间歇性命中)。
 *  回落常量:无会话上下文的后台任务归入同一路由桶,满足网关校验即可。
 *  (#921 拆分 — 原 OpenAICompatibleLlmGateway.headers 私有方法,语义逐行不变。)
 */
export function buildRequestHeaders(options: LlmChatOptions): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${resolveApiKey()}`,
    'User-Agent': 'Heurion/1.0 (medical research agent)',
  }
  if (currentLlmProvider() === 'opencode') {
    h['x-opencode-session'] = options.sessionId || 'heurion-server'
  }
  return h
}
