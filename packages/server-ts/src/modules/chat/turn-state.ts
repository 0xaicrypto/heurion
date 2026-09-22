/**
 * #1106 — 回合生命周期状态机（tool-loop 上帝函数的可变闭包标志收口）。
 *
 * 背景：runToolCallLoop 曾以 15+ 个可变闭包标志同时承载状态机、预算
 * 退出、写回对账、清单纪律与 nudge 注入。标志交互错误会向用户输出错误
 * 的「回合完成」状态，且几乎无法单元测试。本模块把生命周期相关标志
 * 收口为显式状态对象 + 类型化转移（exitByBudget / markWriteFailStreak /
 * exitWithoutRoundCap / shouldExit），tool-loop 内的闭包标志变为对本
 * 对象的薄委托 — 行为零变更（锚定测试闸门）。
 *
 * 退出语义（与原实现逐字一致）：
 *   - `roundCap`：while 自然结束（局部轮次耗尽）— 初始态即「按轮次
 *     耗尽退出」，任何其他出口先清除该标志。
 *   - `budget`：回合级预算耗尽（任一维度）— 清除轮次耗尽标志。
 *   - `writeStreak`：doc- 会话写回连败早退 — 清除轮次耗尽标志。
 * `shouldExit()` 供轮次循环 walker 后判定；`exitedByRoundCap` 供收尾
 * 的轮次上限提示判定；`exitedByBudget` 供返回值 exhaustedReason 判定。
 */

/** 回合退出原因（walker 后应否提前结束轮次循环）。 */
export type TurnExitReason = 'roundCap' | 'budget' | 'writeStreak'

export interface TurnStateSnapshot {
  toolRound: number
  exitedByRoundCap: boolean
  exitedByBudget: boolean
  writeFailStreakExit: boolean
  anyToolExecuted: boolean
  docWriteExecuted: number
  docWriteSucceeded: number
  executedToolCallsTotal: number
  executedWriteToolNames: string[]
  unbackedClaimCount: number
  planBacklogCount: number
  planPendingText: string
  planWasManaged: boolean
  planNudgeInjected: boolean
  lastRoundHadFailure: boolean
  reasoningOverBudget: boolean
}

export class TurnState {
  /** 当前轮次（1-based；0 = 尚未进入首轮）。 */
  toolRound = 0
  /** 本回合是否执行过任意工具（轮次上限提示的必要条件）。 */
  anyToolExecuted = false
  /** #892: 写回工具执行次数（成功或失败都算「已执行」）。 */
  docWriteExecuted = 0
  /** #977: 成功写回次数 — 对账守卫一律用 succeeded 口径。 */
  docWriteSucceeded = 0
  /** 方案 A: 回合内已执行工具调用总数（任意工具，拦截不计）。 */
  executedToolCallsTotal = 0
  /** P0 hotfix 2026-09: 实际执行过的写回工具名单（去重，首执行顺序）。 */
  readonly executedWriteToolNames: string[] = []
  /** #967: 部分执行对账缺口（claimed 数）。 */
  unbackedClaimCount = 0
  /** #972: 活跃清单缺口（pending+failed 步数）与接力方案段。 */
  planBacklogCount = 0
  planPendingText = ''
  /** #979: 本回合是否执行过 set_task_plan（文本计划表守卫豁免依据）。 */
  planWasManaged = false
  /** 方案 A: 行为观察 nudge 一次性注入标志。 */
  planNudgeInjected = false

  private exitedByRoundCapFlag = true
  private exitedByBudgetFlag = false
  private writeFailStreakExitFlag = false
  private lastRoundHadFailureFlag = false
  private reasoningOverBudgetFlag = false

  // ------------------------------------------------------------------
  // 轮次节奏（#1023 修正性重试 + #1026 reasoning 熔断）
  // ------------------------------------------------------------------

  /** 消费上一轮的失败标记 — 返回本轮是否为修正性重试（读取即复位）。 */
  consumeCorrectiveRetry(): boolean {
    const was = this.lastRoundHadFailureFlag
    this.lastRoundHadFailureFlag = false
    return was
  }

  /** #1023: 工具失败 → 下一轮按修正性重试收紧完成预算。 */
  markRoundFailed(): void {
    this.lastRoundHadFailureFlag = true
  }

  /** #1026: reasoning 已越过回合预算（非流式回退路径的事后判定）。 */
  markReasoningOverBudget(): void {
    this.reasoningOverBudgetFlag = true
  }

  get reasoningOverBudget(): boolean {
    return this.reasoningOverBudgetFlag
  }

  // ------------------------------------------------------------------
  // 退出转移
  // ------------------------------------------------------------------

  /** #1019/#1026: 回合级预算耗尽退出（区别于局部轮次上限）。 */
  exitByBudget(): void {
    this.exitedByBudgetFlag = true
    this.exitedByRoundCapFlag = false
  }

  /** #978: 写回连败早退置位（finishCall 检出连败时）。 */
  markWriteFailStreak(): void {
    this.writeFailStreakExitFlag = true
    this.exitedByRoundCapFlag = false
  }

  /** 模型主动收尾 / 空回复 / 守卫 break — 非轮次耗尽退出。 */
  exitWithoutRoundCap(): void {
    this.exitedByRoundCapFlag = false
  }

  /** walker 后应否提前结束轮次循环（null = 继续/自然结束）。 */
  shouldExit(): TurnExitReason | null {
    if (this.exitedByBudgetFlag) return 'budget'
    if (this.writeFailStreakExitFlag) return 'writeStreak'
    return null
  }

  get exitedByBudget(): boolean {
    return this.exitedByBudgetFlag
  }

  get exitedByRoundCap(): boolean {
    return this.exitedByRoundCapFlag
  }

  get writeFailStreakExit(): boolean {
    return this.writeFailStreakExitFlag
  }

  // ------------------------------------------------------------------
  // 写回记账（#892/#977/#978）
  // ------------------------------------------------------------------

  /** 写回工具真实执行一次（成功或失败都计入；成功单独计数）。 */
  markDocWriteExecuted(toolName: string, success: boolean): void {
    this.docWriteExecuted += 1
    if (success) this.docWriteSucceeded += 1
    if (!this.executedWriteToolNames.includes(toolName)) this.executedWriteToolNames.push(toolName)
  }

  /** #978: doc- 会话写回连败早退条件（尝试 ≥2 且成功 0）。 */
  shouldEarlyExitOnWriteStreak(sessionId: string): boolean {
    return sessionId.startsWith('doc-')
      && this.docWriteSucceeded === 0
      && this.docWriteExecuted - this.docWriteSucceeded >= 2
  }

  /** 方案 A: 工具调用计数（任意工具，拦截调用不经此）。 */
  bumpToolCall(): void {
    this.executedToolCallsTotal += 1
  }

  /** 观测快照（测试/遥测）。 */
  snapshot(): TurnStateSnapshot {
    return {
      toolRound: this.toolRound,
      exitedByRoundCap: this.exitedByRoundCapFlag,
      exitedByBudget: this.exitedByBudgetFlag,
      writeFailStreakExit: this.writeFailStreakExitFlag,
      anyToolExecuted: this.anyToolExecuted,
      docWriteExecuted: this.docWriteExecuted,
      docWriteSucceeded: this.docWriteSucceeded,
      executedToolCallsTotal: this.executedToolCallsTotal,
      executedWriteToolNames: [...this.executedWriteToolNames],
      unbackedClaimCount: this.unbackedClaimCount,
      planBacklogCount: this.planBacklogCount,
      planPendingText: this.planPendingText,
      planWasManaged: this.planWasManaged,
      planNudgeInjected: this.planNudgeInjected,
      lastRoundHadFailure: this.lastRoundHadFailureFlag,
      reasoningOverBudget: this.reasoningOverBudgetFlag,
    }
  }
}
