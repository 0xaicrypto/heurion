import { describe, test, expect } from 'vitest'
import { TurnBudget, turnBudgetExhaustedNotice } from '../../src/modules/chat/turn-budget.js'

/** #1019 — 回合级共享预算:轮次/工具调用/推理字数/墙钟统一记账。 */
describe('#1019 TurnBudget — 统一预算记账', () => {
  test('轮次额度:tryStartRound 扣减,用尽后返回 false 并固化原因', () => {
    const b = new TurnBudget({ maxRounds: 3, maxWallMs: 10 * 60_000 })
    expect(b.tryStartRound()).toBe(true)
    expect(b.tryStartRound()).toBe(true)
    expect(b.remainingRounds).toBe(1)
    expect(b.tryStartRound()).toBe(true)
    expect(b.tryStartRound()).toBe(false)
    expect(b.exhaustedReason).toBe('rounds')
    expect(b.snapshot()).toMatchObject({ rounds: 3, remainingRounds: 0 })
  })

  test('工具调用额度:countToolCall 累计,tryStartRound 前置拒绝', () => {
    const b = new TurnBudget({ maxRounds: 5, maxToolCalls: 2, maxWallMs: 10 * 60_000 })
    b.countToolCall()
    b.countToolCall()
    expect(b.exhausted()).toBe('tool_calls')
    expect(b.tryStartRound()).toBe(false)
    expect(b.exhaustedReason).toBe('tool_calls')
    expect(b.snapshot().toolCalls).toBe(2)
  })

  test('推理字数:countReasoning 越线返回 true,下一轮被拒', () => {
    const b = new TurnBudget({ maxRounds: 5, maxReasoningChars: 100, maxWallMs: 10 * 60_000 })
    expect(b.countReasoning(60)).toBe(false)
    expect(b.countReasoning(50)).toBe(true)
    expect(b.tryStartRound()).toBe(false)
    expect(b.exhaustedReason).toBe('reasoning')
  })

  test('墙钟:超过 maxWallMs 后 tryStartRound 拒绝(可注入 now)', () => {
    let now = 1_000
    const b = new TurnBudget({ maxRounds: 5, maxWallMs: 60_000 }, () => now)
    expect(b.tryStartRound()).toBe(true)
    now += 60_001
    expect(b.tryStartRound()).toBe(false)
    expect(b.exhaustedReason).toBe('wall_clock')
  })

  test('正常收尾:未超限时 exhausted() 为 null', () => {
    const b = new TurnBudget({ maxRounds: 8 })
    b.tryStartRound()
    b.countToolCall()
    b.countReasoning(10)
    expect(b.exhausted()).toBeNull()
    expect(b.exhaustedReason).toBeNull()
  })

  test('用户提示文案:按耗尽维度给出可行动说明', () => {
    const rounds = new TurnBudget({ maxRounds: 1 })
    rounds.tryStartRound()
    rounds.tryStartRound()
    expect(turnBudgetExhaustedNotice(rounds)).toContain('轮次')

    const tools = new TurnBudget({ maxToolCalls: 1 })
    tools.countToolCall()
    tools.tryStartRound()
    expect(turnBudgetExhaustedNotice(tools)).toContain('工具调用')

    const reasoning = new TurnBudget({ maxRounds: 5, maxReasoningChars: 10 })
    reasoning.countReasoning(20)
    reasoning.tryStartRound()
    expect(turnBudgetExhaustedNotice(reasoning)).toContain('推理量')

    let now = 1_000
    const wall = new TurnBudget({ maxWallMs: 1_000 }, () => now)
    now += 2_000
    wall.tryStartRound()
    expect(turnBudgetExhaustedNotice(wall)).toContain('耗时')

    const notice = turnBudgetExhaustedNotice(rounds)
    expect(notice).toContain('已停止本轮自动重试')
    expect(notice).toContain('拆小')
  })
})
