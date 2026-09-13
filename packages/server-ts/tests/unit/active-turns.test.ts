import { describe, test, expect, vi } from 'vitest'
import { registerActiveTurn, activeTurnCount, drainActiveTurns } from '../../src/modules/chat/active-turns.js'

/** #1028（阶段一）— 关停排空：未收尾回合走交代过的终止，已收尾的跳过。 */
describe('#1028 active-turns drain', () => {
  test('未 settled 的回合被强制终结（onShutdown + abort）；settled 的跳过', async () => {
    const shutdownA = vi.fn(async () => {})
    const abortA = new AbortController()
    const unregA = registerActiveTurn({
      sessionId: 's_a', userId: 'u', abort: abortA,
      settled: () => false,
      onShutdown: shutdownA,
    })
    const shutdownB = vi.fn(async () => {})
    const unregB = registerActiveTurn({
      sessionId: 's_b', userId: 'u', abort: new AbortController(),
      settled: () => true,
      onShutdown: shutdownB,
    })
    expect(activeTurnCount()).toBe(2)

    const res = await drainActiveTurns(0)

    expect(shutdownA).toHaveBeenCalledTimes(1)
    expect(shutdownB).not.toHaveBeenCalled()
    expect(abortA.signal.aborted).toBe(true)
    expect(res.forced).toBe(1)
    expect(activeTurnCount()).toBe(0)
    unregA(); unregB() // drain 已清空，注销幂等
  })

  test('grace 窗口内自然收尾 → 不强制终结', async () => {
    let settled = false
    const onShutdown = vi.fn(async () => {})
    registerActiveTurn({
      sessionId: 's_c', userId: 'u', abort: new AbortController(),
      settled: () => settled,
      onShutdown,
    })
    setTimeout(() => { settled = true }, 50)
    const res = await drainActiveTurns(500)
    expect(onShutdown).not.toHaveBeenCalled()
    expect(res.forced).toBe(0)
    expect(activeTurnCount()).toBe(0)
  })

  test('注销回合后不再被排空', async () => {
    const onShutdown = vi.fn(async () => {})
    const unregister = registerActiveTurn({
      sessionId: 's_d', userId: 'u', abort: new AbortController(),
      settled: () => false,
      onShutdown,
    })
    unregister()
    await drainActiveTurns(0)
    expect(onShutdown).not.toHaveBeenCalled()
  })
})
