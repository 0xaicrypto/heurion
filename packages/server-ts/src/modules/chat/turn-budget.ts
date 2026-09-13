/**
 * #1019 — 回合级共享预算（main tool-loop + doc-executor rescue 同一份）。
 *
 * 背景：此前 `MAX_TOOL_ROUNDS = 5` 是两层循环各自的局部上限 — 主循环失败
 * 后 rescue 另起一轮全新的 `runToolCallLoop`，自带 5 轮、自带推理预算，
 * 最坏一次用户回合可达约 10 轮 LLM 调用且互不通气（推理字数/墙钟无统一
 * 天花板，只能靠 60 分钟 watchdog 兜底）。
 *
 * 本对象把轮次/工具调用/推理字数/墙钟统一记账，从 conversation-turn 同时
 * 传入主循环与 rescue：rescue 消费主循环的剩余额度，而不是再领一份新的。
 * 局部轮次上限保留（主循环 5 轮是「策略切换点」：毒上下文里继续重试已被
 * 证伪，到点转精简上下文 rescue），但总额度由这里封顶。
 */
export type TurnBudgetExhaustReason = 'rounds' | 'tool_calls' | 'reasoning' | 'wall_clock'

export interface TurnBudgetLimits {
  /** 整个回合的 LLM 调用（工具轮次）总上限 — main + rescue 共享。 */
  maxRounds: number
  /** 整个回合真实执行的工具调用总次数上限。 */
  maxToolCalls: number
  /** 整个回合累计 reasoning 字数上限（与 streaming 层 150k 观测阈值同口径）。 */
  maxReasoningChars: number
  /** 整个回合墙钟上限（watchdog 之外的第一道主动熔断）。 */
  maxWallMs: number
}

export interface TurnBudgetSnapshot {
  rounds: number
  toolCalls: number
  reasoningChars: number
  elapsedMs: number
  remainingRounds: number
}

function envInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || '', 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/** 环境可覆盖的默认限额（测试可显式部分覆盖）。 */
export function defaultTurnBudgetLimits(): TurnBudgetLimits {
  return {
    // 主循环局部上限 5 轮 + rescue 最多 3 轮 — 共享同一天花板，不再 5+5。
    maxRounds: envInt('TURN_MAX_ROUNDS', 8),
    maxToolCalls: envInt('TURN_MAX_TOOL_CALLS', 40),
    maxReasoningChars: envInt('TURN_MAX_REASONING_CHARS', 150_000),
    // 与 chat-handler watchdog 同源（TURN_MAX_MS）— #1026 起作为主动熔断先于
    // watchdog 生效。
    maxWallMs: envInt('TURN_MAX_MS', 60 * 60_000),
  }
}

export class TurnBudget {
  readonly limits: TurnBudgetLimits
  private _rounds = 0
  private _toolCalls = 0
  private _reasoningChars = 0
  private readonly startedAt: number
  private readonly now: () => number
  private reason: TurnBudgetExhaustReason | null = null

  constructor(limits: Partial<TurnBudgetLimits> = {}, now: () => number = Date.now) {
    this.limits = { ...defaultTurnBudgetLimits(), ...limits }
    this.now = now
    this.startedAt = now()
  }

  get rounds(): number { return this._rounds }
  get remainingRounds(): number { return Math.max(0, this.limits.maxRounds - this._rounds) }
  get elapsedMs(): number { return this.now() - this.startedAt }
  /** 已记录的耗尽原因（tryStartRound 命中后固化）。 */
  get exhaustedReason(): TurnBudgetExhaustReason | null { return this.reason }

  snapshot(): TurnBudgetSnapshot {
    return {
      rounds: this._rounds,
      toolCalls: this._toolCalls,
      reasoningChars: this._reasoningChars,
      elapsedMs: this.elapsedMs,
      remainingRounds: this.remainingRounds,
    }
  }

  /** 任意维度超限 → 原因（不固化，供前置检查/提示文案）。 */
  exhausted(): TurnBudgetExhaustReason | null {
    if (this.reason) return this.reason
    if (this._rounds >= this.limits.maxRounds) return 'rounds'
    if (this._toolCalls >= this.limits.maxToolCalls) return 'tool_calls'
    if (this._reasoningChars >= this.limits.maxReasoningChars) return 'reasoning'
    if (this.elapsedMs >= this.limits.maxWallMs) return 'wall_clock'
    return null
  }

  /** 尝试消耗一轮（一次 LLM 调用）；额度不足返回 false 并固化原因。 */
  tryStartRound(): boolean {
    const reason = this.exhausted()
    if (reason) {
      this.reason ??= reason
      return false
    }
    this._rounds++
    return true
  }

  /** 工具真实执行后计数（doom-loop/熔断拦截的调用不计）。 */
  countToolCall(): void {
    this._toolCalls++
  }

  /** #1026: 外部熔断（流内 reasoning/墙钟）— 固化原因，供提示文案使用。 */
  forceExhaust(reason: TurnBudgetExhaustReason): void {
    this.reason ??= reason
  }

  /** 累计流式 reasoning 增量；返回是否越过上限（供流层中止/下一轮熔断）。 */
  countReasoning(chars: number): boolean {
    this._reasoningChars += Math.max(0, chars)
    return this._reasoningChars >= this.limits.maxReasoningChars
  }
}

/** 预算耗尽时的用户可见、可行动的失败文案（#1019/#1026 共用）。 */
export function turnBudgetExhaustedNotice(budget: TurnBudget): string {
  const s = budget.snapshot()
  const reason = budget.exhaustedReason ?? 'rounds'
  const detail =
    reason === 'tool_calls' ? `工具调用次数已达上限（${s.toolCalls} 次）`
    : reason === 'reasoning' ? `推理量已达上限（约 ${Math.round(s.reasoningChars / 1000)}k 字）`
    : reason === 'wall_clock' ? `本回合耗时已达上限（约 ${Math.max(1, Math.round(s.elapsedMs / 60_000))} 分钟）`
    : `自动重试轮次已达上限（${s.rounds} 轮）`
  return `⚠️ ${detail}，为避免继续消耗已停止本轮自动重试。你可以查看上方过程详情，把任务拆小或换一种描述后重试。`
}
