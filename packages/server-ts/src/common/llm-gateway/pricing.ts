/**
 * #921 — llm-gateway 拆分:计费/用量/遥测记录。
 * 纯机械搬移自 src/common/llm-gateway.ts — 零行为变化。
 */
import { log, getTelemetryRecorder, type ChatMessage, type LlmChatOptions } from './types.js'

let llmPricingWarned = false

function getPricing(model: string): { input: number; output: number } {
  const defaults: Record<string, { input: number; output: number }> = {
    'deepseek-chat': { input: 0.27, output: 1.10 },
    'deepseek-reasoner': { input: 0.55, output: 2.19 },
    'deepseek-v4-flash': { input: 0.27, output: 1.10 },
    'deepseek-v4-flash-vision-exp': { input: 0.27, output: 1.10 },
    'deepseek-v4-pro': { input: 0.55, output: 2.19 },
  }
  // #911: 计费主路径不再裸 parse — env 坏 JSON 回退 {},只 warn 一次(避免每调用刷屏)。
  let envPricing: Record<string, { input: number; output: number }> = {}
  if (process.env.LLM_PRICING) {
    try {
      envPricing = JSON.parse(process.env.LLM_PRICING) || {}
    } catch (err) {
      if (!llmPricingWarned) {
        llmPricingWarned = true
        log.warn('LLM_PRICING env is not valid JSON — falling back to built-in pricing', { reason: (err as Error).message.slice(0, 120) })
      }
      envPricing = {}
    }
  }
  return (
    envPricing[model] ||
    defaults[model] || {
      input: parseFloat(process.env.LLM_DEFAULT_INPUT_PRICE_PER_1M || '1.0'),
      output: parseFloat(process.env.LLM_DEFAULT_OUTPUT_PRICE_PER_1M || '3.0'),
    }
  )
}

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const p = getPricing(model)
  return (promptTokens * p.input + completionTokens * p.output) / 1_000_000
}

export function approximateTokensFromChars(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4))
}

export function promptChars(messages: ChatMessage[]): number {
  return messages.reduce((acc, m) => {
    if (typeof m.content === 'string') return acc + m.content.length
    return acc + m.content.reduce((a, p) => a + (p.type === 'text' ? p.text.length : p.dataBase64.length / 2), 0)
  }, 0)
}

async function recordUsage(
  model: string,
  options: LlmChatOptions,
  promptTokens: number,
  completionTokens: number,
  cacheHitTokens = 0,
  cacheMissTokens = 0,
): Promise<void> {
  const totalTokens = promptTokens + completionTokens
  const costUsd = estimateCost(model, promptTokens, completionTokens)
  // O3 (#108): surface DeepSeek cache usage so cache effectiveness is visible.
  const cachePct = promptTokens > 0 ? Math.round((cacheHitTokens / promptTokens) * 100) : 0
  log.info(`[LLM] model=${model} prompt=${promptTokens} (cache hit ${cacheHitTokens}/${cachePct}%) completion=${completionTokens} total=${totalTokens} costUsd≈${costUsd.toFixed(6)}`)
  const recorder = getTelemetryRecorder()
  if (options.telemetryContext && recorder) {
    await recorder
      .record({
        userId: options.telemetryContext.userId,
        workspaceId: options.telemetryContext.workspaceId,
        category: 'llm_cost',
        action: options.telemetryContext.action,
        metadata: { model, promptTokens, completionTokens, totalTokens, costUsd, cacheHitTokens, cacheMissTokens, cacheHitPct: cachePct },
      })
      .catch(() => {})
  }
}

/** #802: 失败/超时调用与成功对称可观测 — 此前只有成功才打 [LLM] 行，
 *  超时轮次在日志与 telemetry 里完全无痕（现场：309s 静默死亡无任何记录）。
 *  console 一行 + telemetry_events 表 llm_error 类目（DB 持久化,重启不丢）。 */
async function recordFailure(
  model: string,
  options: LlmChatOptions,
  err: unknown,
  chars: number,
  elapsedMs: number,
): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err)
  const promptTokens = approximateTokensFromChars(chars)
  log.info(`[LLM] failed model=${model} elapsedMs=${elapsedMs} prompt≈${promptTokens} error=${msg.slice(0, 300)}`)
  const recorder = getTelemetryRecorder()
  if (options.telemetryContext && recorder) {
    await recorder
      .record({
        userId: options.telemetryContext.userId,
        workspaceId: options.telemetryContext.workspaceId,
        category: 'llm_error',
        action: options.telemetryContext.action,
        metadata: { model, elapsedMs, promptTokens, error: msg.slice(0, 500) },
      })
      .catch(() => {})
  }
}

export { recordUsage, recordFailure }
