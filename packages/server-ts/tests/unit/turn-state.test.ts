import { describe, test, expect, vi } from 'vitest'
import { TurnState } from '../../src/modules/chat/turn-state.js'

/**
 * #1106 — 回合生命周期状态机单元测试。
 *
 * tool-loop 的 15+ 可变闭包标志收口为 TurnState 的类型化转移 — 本文件
 * 钉死转移语义（退出优先级 / 修正性重试读后即清 / 写回口径 / 连败早退
 * 条件），与 tool-loop 回合生命周期锚定测试互为表里。
 */
describe('#1106 TurnState — 退出转移与优先级', () => {
  test('初始态:按「轮次耗尽退出」占位,shouldExit 为 null(自然耗尽可能)', () => {
    const s = new TurnState()
    expect(s.shouldExit()).toBeNull()
    expect(s.exitedByRoundCap).toBe(true)
    expect(s.exitedByBudget).toBe(false)
    expect(s.writeFailStreakExit).toBe(false)
  })

  test('exitByBudget: 清除轮次耗尽标志;budget 出口为置位后直接 break,不经 shouldExit(walker 判定)', () => {
    const s = new TurnState()
    s.exitByBudget()
    expect(s.exitedByBudget).toBe(true)
    expect(s.exitedByRoundCap).toBe(false)
    expect(s.shouldExit()).toBeNull()
  })

  test('markWriteFailStreak → shouldExit=writeStreak(连败早退是唯一的 walker 级提前退出)', () => {
    const s = new TurnState()
    s.markWriteFailStreak()
    expect(s.shouldExit()).toBe('writeStreak')
    expect(s.exitedByRoundCap).toBe(false)
  })

  test('exitWithoutRoundCap 只清轮次耗尽标志,不进入提前退出', () => {
    const s = new TurnState()
    s.exitWithoutRoundCap()
    expect(s.exitedByRoundCap).toBe(false)
    expect(s.shouldExit()).toBeNull()
  })

  test('reasoning 熔断标志置位后由循环消费(非流式回退路径事后判定)', () => {
    const s = new TurnState()
    expect(s.reasoningOverBudget).toBe(false)
    s.markReasoningOverBudget()
    expect(s.reasoningOverBudget).toBe(true)
  })
})

describe('#1106 TurnState — 修正性重试（#1023 读后即清语义）', () => {
  test('markRoundFailed 后下一轮读 true,再读复位 false', () => {
    const s = new TurnState()
    expect(s.consumeCorrectiveRetry()).toBe(false)
    s.markRoundFailed()
    expect(s.consumeCorrectiveRetry()).toBe(true)
    expect(s.consumeCorrectiveRetry()).toBe(false)
  })
})

describe('#1106 TurnState — 写回记账与连败早退（#892/#977/#978）', () => {
  test('markDocWriteExecuted:执行/成功分开计数,名单去重按首执行顺序', () => {
    const s = new TurnState()
    s.markDocWriteExecuted('edit_document', true)
    s.markDocWriteExecuted('insert_asset', false)
    s.markDocWriteExecuted('edit_document', true)
    expect(s.docWriteExecuted).toBe(3)
    expect(s.docWriteSucceeded).toBe(2)
    expect(s.executedWriteToolNames).toEqual(['edit_document', 'insert_asset'])
  })

  test('连败早退条件:doc- 会话尝试≥2 且成功 0;非 doc 会话不早退', () => {
    const s = new TurnState()
    expect(s.shouldEarlyExitOnWriteStreak('doc-doc_x')).toBe(false)
    s.markDocWriteExecuted('edit_document', false)
    expect(s.shouldEarlyExitOnWriteStreak('doc-doc_x')).toBe(false)
    s.markDocWriteExecuted('edit_document', false)
    expect(s.shouldEarlyExitOnWriteStreak('doc-doc_x')).toBe(true)
    expect(s.shouldEarlyExitOnWriteStreak('sess_chat')).toBe(false)
  })

  test('失败-成功交替:成功 1 次后不满足零成功条件', () => {
    const s = new TurnState()
    s.markDocWriteExecuted('edit_document', false)
    s.markDocWriteExecuted('edit_document', true)
    s.markDocWriteExecuted('edit_document', false)
    expect(s.shouldEarlyExitOnWriteStreak('doc-doc_x')).toBe(false)
  })
})

describe('#1106 TurnState — snapshot 观测快照', () => {
  test('快照包含全部生命周期字段,名单数组为副本(外部改写不影响内部态)', () => {
    const s = new TurnState()
    s.toolRound = 2
    s.anyToolExecuted = true
    s.markDocWriteExecuted('edit_document', true)
    s.planWasManaged = true
    const snap = s.snapshot()
    expect(snap).toMatchObject({
      toolRound: 2,
      exitedByRoundCap: true,
      exitedByBudget: false,
      writeFailStreakExit: false,
      anyToolExecuted: true,
      docWriteExecuted: 1,
      docWriteSucceeded: 1,
      executedWriteToolNames: ['edit_document'],
      unbackedClaimCount: 0,
      planBacklogCount: 0,
      planPendingText: '',
      planWasManaged: true,
      planNudgeInjected: false,
      lastRoundHadFailure: false,
      reasoningOverBudget: false,
    })
    snap.executedWriteToolNames.push('injected')
    expect(s.executedWriteToolNames).toEqual(['edit_document'])
    expect(s.snapshot().executedWriteToolNames).toEqual(['edit_document'])
  })

  test('bumpToolCall 计数任意工具真实执行(拦截调用不经此)', () => {
    const s = new TurnState()
    s.bumpToolCall()
    s.bumpToolCall()
    s.bumpToolCall()
    expect(s.executedToolCallsTotal).toBe(3)
  })
})
