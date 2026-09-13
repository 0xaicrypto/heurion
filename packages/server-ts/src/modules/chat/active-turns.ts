/**
 * #1028（阶段一）— 在飞回合登记与关停排空。
 *
 * 背景：agent 回合生命周期绑在「一次 SSE 连接 + 一个进程」上 — SIGTERM
 * （开发热重载/部署/崩溃）直接杀进程，不落中断标记、事件日志不保证 flush，
 * 前端只看到连接断开。这里登记在飞回合，关停时先给 grace 窗口自然收尾，
 * 未收尾的走 onShutdown（中断标记 + 交代过的终止信号 + 关 SSE），再统一
 * flush 事件日志（见 user-context.flushAllUserContexts）。
 */
import { makeLogger } from '../../common/logger.js'

const log = makeLogger('chat.active-turns')

export interface ActiveTurnHandle {
  sessionId: string
  userId: string
  /** 外部中止信号（排空兜底时 abort 整条工具链路）。 */
  abort: AbortController
  /** 回合是否已正常/错误收尾（settled 的不再被强制终结）。 */
  settled: () => boolean
  /** 交代过的终止：落 interrupted marker + 发 error/turn_complete + 关 SSE。 */
  onShutdown: () => Promise<void>
}

const activeTurns = new Map<symbol, ActiveTurnHandle>()

/** 登记一个在飞回合；返回注销函数（回合 finally 调用）。 */
export function registerActiveTurn(handle: ActiveTurnHandle): () => void {
  const key = Symbol('active-turn')
  activeTurns.set(key, handle)
  return () => { activeTurns.delete(key) }
}

export function activeTurnCount(): number {
  return activeTurns.size
}

/**
 * 关停排空：先等 graceMs 让回合自然收尾；仍未收尾的强制走 onShutdown
 * （先写中断标记/终止信号，再 abort 工具链路）。返回强制终结数。
 */
export async function drainActiveTurns(graceMs = 3000): Promise<{ drained: number; forced: number }> {
  const drained = activeTurns.size
  const deadline = Date.now() + Math.max(0, graceMs)
  while (activeTurns.size > 0 && Date.now() < deadline) {
    // 全部已收尾（finally 尚未注销的窗口）→ 提前结束等待。
    if ([...activeTurns.values()].every((h) => h.settled())) break
    await new Promise((r) => setTimeout(r, 100))
  }
  let forced = 0
  for (const handle of [...activeTurns.values()]) {
    if (handle.settled()) continue
    forced++
    try {
      await handle.onShutdown()
    } catch (err) {
      log.warn('turn shutdown handler failed', { sessionId: handle.sessionId, err: String(err) })
    }
    try { handle.abort.abort() } catch { /* already aborted */ }
  }
  // 给 SSE 写事件一个微任务/事件循环周期（中断标记 + turn_complete 已发出）。
  await new Promise((r) => setTimeout(r, 50))
  activeTurns.clear()
  return { drained, forced }
}
