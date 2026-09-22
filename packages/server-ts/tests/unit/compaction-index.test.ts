import { describe, test, expect } from 'vitest'
import { oldestRetainedEventIdx } from '../../src/modules/chat/history-budget.js'

/**
 * #严重-4 — 压缩边界索引回归。history 为 oldest-first（EventLog.query
 * newest-first → loadHistoryBudget reverse），保留窗口是它的**尾部** N 条。
 * 旧的 `history[retainedCount - 1]` 从另一端取，长会话里导致中间段
 * 既不在上下文、又永远不被压缩（记忆黑洞）。
 */
const events = (n: number, startIdx = 1) =>
  Array.from({ length: n }, (_, i) => ({ idx: startIdx + i, eventType: 'user_message', content: `m${i}` }))

describe('oldestRetainedEventIdx (#严重-4)', () => {
  test('just-at-threshold: all 40 events retained → oldest of the window, not the newest', () => {
    const h = events(40)
    expect(oldestRetainedEventIdx(h, 40)).toBe(1)
    // 旧错误值：history[39].idx = newest（40）→ 会压缩到只剩最后一条
    expect(oldestRetainedEventIdx(h, 40)).not.toBe(40)
  })

  test('long session: 320 events with 40 retained → tail window start (idx 281)', () => {
    const h = events(320)
    expect(oldestRetainedEventIdx(h, 40)).toBe(281)
    // 旧错误值：history[39].idx = 40 → 中间 241 条永远不会被压缩
    expect(oldestRetainedEventIdx(h, 40)).not.toBe(40)
  })

  test('retainedCount 1 → newest event only', () => {
    expect(oldestRetainedEventIdx(events(10), 1)).toBe(10)
  })

  test('retainedCount ≥ history.length → oldest overall', () => {
    expect(oldestRetainedEventIdx(events(10), 99)).toBe(1)
  })

  test('empty history / zero retained → 0 (cursor-safe)', () => {
    expect(oldestRetainedEventIdx([], 0)).toBe(0)
    expect(oldestRetainedEventIdx([], 5)).toBe(0)
    expect(oldestRetainedEventIdx(events(10), 0)).toBe(0)
  })

  test('missing idx field → 0, never NaN', () => {
    expect(oldestRetainedEventIdx([{ eventType: 'user_message' }], 1)).toBe(0)
  })
})
