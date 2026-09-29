import { describe, test, expect, vi } from 'vitest'
import { releaseRequestScope, type RequestScope } from '../../src/common/request-context.js'

/**
 * #1150-followup — 请求作用域引用释放幂等:客户端中途断开时 onResponse
 * 不触发(仅 raw close),两处共用释放;重复调用不得把用户 context 计数
 * 多扣(否则会提前驱逐在飞 context)。
 */
describe('#1150-followup releaseRequestScope', () => {
  test('首次释放逐个引用;重复调用幂等(不重复扣减)', () => {
    const scope: RequestScope = { requestId: 'r1', contextRefs: new Set(['u1', 'u2']) }
    const release = vi.fn()
    releaseRequestScope(scope, release)
    expect(release).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenCalledWith('u1')
    expect(release).toHaveBeenCalledWith('u2')
    // onResponse 与 raw close 都触发 → 第二次必须 no-op
    releaseRequestScope(scope, release)
    expect(release).toHaveBeenCalledTimes(2)
    expect(scope.released).toBe(true)
  })

  test('无引用时释放为 no-op', () => {
    const scope: RequestScope = { requestId: 'r2', contextRefs: new Set() }
    const release = vi.fn()
    releaseRequestScope(scope, release)
    expect(release).not.toHaveBeenCalled()
  })
})
