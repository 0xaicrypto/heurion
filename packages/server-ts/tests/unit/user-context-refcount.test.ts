import { describe, test, expect } from 'vitest'
import { runWithRequestScope } from '../../src/common/request-context.js'
import {
  getUserContext,
  releaseUserContext,
  sweepUserContexts,
  __setUserContextLastAccess,
  __userContextRefCount,
} from '../../src/modules/shared/user-context.js'

/**
 * #1146 — user-context 驱逐与在飞写入竞争:长回合持有旧 ctx 超过 30 分钟
 * 被驱逐后,新旧实例各自维护 nextIdx 写同一 JSONL → idx 重复/丢更新。
 * 修复:请求级引用计数 — 引用中的 ctx 不驱逐,请求结束(onResponse)释放。
 */
const TTL_PAST = () => Date.now() - 31 * 60 * 1000

describe('#1146 user-context 引用计数驱逐', () => {
  test('请求持有期间超 TTL 不驱逐;释放后按 TTL 驱逐', () => {
    const userId = `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const scope = { requestId: 'r1', contextRefs: new Set<string>() }
    runWithRequestScope(scope, () => {
      getUserContext(userId)
      getUserContext(userId) // 同一请求重复取用只记一次引用
    })
    expect(__userContextRefCount(userId)).toBe(1)
    expect(scope.contextRefs.has(userId)).toBe(true)

    __setUserContextLastAccess(userId, TTL_PAST())
    expect(sweepUserContexts()).toBe(0) // 引用中 — 修复前会被驱逐

    releaseUserContext(userId)
    expect(__userContextRefCount(userId)).toBe(0)
    expect(sweepUserContexts()).toBe(1)
    expect(__userContextRefCount(userId)).toBeUndefined()
  })

  test('无请求作用域(后台任务)仍按 TTL 驱逐', () => {
    const userId = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    getUserContext(userId)
    expect(__userContextRefCount(userId)).toBe(0)
    __setUserContextLastAccess(userId, TTL_PAST())
    expect(sweepUserContexts()).toBe(1)
  })
})
