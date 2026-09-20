import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * #1085 回归网 — doc_updated rev 时间基单调。
 *
 * 旧实现（纯内存小整数计数器）在服务端重启后从 0 重新计数，已打开标签页
 * 的 appliedDocRevRef 停在重启前高位，重启后全部写回被 shouldApplyDocRev
 * 幂等守卫误判为乱序静默丢弃（须手动刷新）。修复 = rev 取
 * `max(计数器+1, Date.now())`：进程内严格递增（+1 兜底同毫秒写），跨重启
 * 新进程首笔 rev 即当前毫秒，必然大于旧进程历史计数。
 *
 * "重启"在本测试中以 vi.resetModules() 重载模块模拟（模块级计数器随模块
 * 实例重置 — 与进程重启后计数器归零同构）。
 */

async function importFresh() {
  vi.resetModules()
  return await import('../../src/modules/chat/tool-loop.js')
}

describe('#1085 doc_updated rev 时间基单调', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('进程内严格递增：同毫秒多次写回 rev 仍单调（+1 兜底）', async () => {
    const { nextDocWriteRev } = await importFresh()
    const a = nextDocWriteRev()
    const b = nextDocWriteRev()
    const c = nextDocWriteRev()
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
  })

  test('模拟服务端重启：计数器归零后新 rev 必然大于重启前全部 rev', async () => {
    // 旧进程：计数器已被推到高位（例如 Date.now() 之前的某时刻起逐步 +1，
    // 也兼容旧版本遗留的小整数计数——两者都远小于新进程的时间基 rev）。
    const oldProc = await importFresh()
    const oldRevs = [oldProc.nextDocWriteRev(), oldProc.nextDocWriteRev(), oldProc.nextDocWriteRev()]

    // "重启"：模块重载 = 计数器归零（旧实现在此处坏掉）。
    const newProc = await importFresh()
    const firstAfterRestart = newProc.nextDocWriteRev()

    // 新进程首笔 rev（时间基）必须大于旧进程全部 rev —— 客户端
    // shouldApplyDocRev(applied=旧高位, incoming=新值) 由此恢复放行
    // （守卫语义严格大于，见 web chat-reducer.test 的 #927 用例）。
    for (const oldRev of oldRevs) {
      expect(firstAfterRestart).toBeGreaterThan(oldRev)
    }
  })

  test('时钟被回拨到过去（NTP 异常边界）：同进程计数器仍不回退', async () => {
    const { nextDocWriteRev } = await importFresh()
    // 真实时钟下先把计数器推到当前毫秒量级。
    const before = nextDocWriteRev()
    // 时钟拨回十年前 — 计数器取 max(计数器+1, 回拨后的 now)，不回退。
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() - 10 * 365 * 24 * 3600 * 1000)
    const after = nextDocWriteRev()
    expect(after).toBeGreaterThan(before)
  })
})
