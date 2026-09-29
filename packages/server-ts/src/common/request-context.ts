/**
 * #1146 — 请求级作用域（AsyncLocalStorage）:
 *  - requestId: 应用日志与 pino 请求日志按相同 id 关联（logger.ts 消费）;
 *  - contextRefs: 请求内取用的 user-context 引用集合 — 长回合持有旧 ctx
 *    超过 TTL 时 GC 不得驱逐（驱逐后新旧 EventLog 各自维护 nextIdx 写同一
 *    JSONL → idx 重复、丢更新）。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface RequestScope {
  requestId: string
  contextRefs: Set<string>
  /** #1150-followup: 幂等释放标记 — onResponse 与 raw close 可能都触发。 */
  released?: boolean
}

/** 释放请求作用域内的 user-context 引用（幂等，回调注入保持分层）。 */
export function releaseRequestScope(scope: RequestScope, release: (userId: string) => void): void {
  if (scope.released) return
  scope.released = true
  for (const userId of scope.contextRefs) release(userId)
}

const scopeStorage = new AsyncLocalStorage<RequestScope>()

export function runWithRequestScope<T>(scope: RequestScope, fn: () => T): T {
  return scopeStorage.run(scope, fn)
}

export function getRequestScope(): RequestScope | undefined {
  return scopeStorage.getStore()
}

/** 请求对象 → scope（onResponse 释放 refs 时可能已离开 ALS 上下文）。 */
export const requestScopes = new WeakMap<object, RequestScope>()
