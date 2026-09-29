import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * #1139 — figure 浏览器单例生命周期:
 *  - 启动失败不得永久缓存 rejected Promise(一次冷启动超时后所有渲染必败);
 *  - chromium disconnected → 重置单例,下一作业重新拉起;
 *  - 回收(阈值)必须等在途作业归零,不得关闭在用浏览器(Target closed)。
 */
const launch = vi.hoisted(() => vi.fn())
vi.mock('puppeteer-core', () => ({ launch }))

import { acquireFigureBrowser, releaseFigureBrowser, resetFigureBrowserForTest } from '../src/handlers/figure.js'

function fakeBrowser() {
  const handlers = new Map<string, Array<() => void>>()
  return {
    on: vi.fn((ev: string, h: () => void) => { handlers.set(ev, [...(handlers.get(ev) ?? []), h]) }),
    close: vi.fn(async () => {}),
    emit: (ev: string) => { for (const h of handlers.get(ev) ?? []) h() },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetFigureBrowserForTest()
})

afterEach(() => {
  resetFigureBrowserForTest()
})

describe('#1139 figure 浏览器单例', () => {
  test('启动失败后下一次 acquire 重新拉起(不缓存 rejected promise)', async () => {
    launch
      .mockRejectedValueOnce(new Error('cold start timeout'))
      .mockResolvedValueOnce(fakeBrowser())

    await expect(acquireFigureBrowser('/chrome')).rejects.toThrow('cold start timeout')
    const browser = await acquireFigureBrowser('/chrome')
    expect(browser).toBeTruthy()
    expect(launch).toHaveBeenCalledTimes(2)
    releaseFigureBrowser()
  })

  test('chromium disconnected → 单例重置并重新拉起', async () => {
    const b1 = fakeBrowser()
    launch.mockResolvedValue(b1)
    const got1 = await acquireFigureBrowser('/chrome')
    releaseFigureBrowser()

    b1.emit('disconnected')

    const b2 = fakeBrowser()
    launch.mockResolvedValue(b2)
    const got2 = await acquireFigureBrowser('/chrome')
    expect(got2).not.toBe(got1)
    expect(launch).toHaveBeenCalledTimes(2)
    releaseFigureBrowser()
  })

  test('#1150-followup 旧作业迟到释放(实例不匹配)不扣新实例计数', async () => {
    const browser = fakeBrowser()
    launch.mockResolvedValue(browser)
    for (let i = 0; i < 48; i++) {
      await acquireFigureBrowser('/chrome')
      releaseFigureBrowser()
    }
    const first = await acquireFigureBrowser('/chrome')  // jobs=49, inFlight=1
    const second = await acquireFigureBrowser('/chrome') // jobs=50 → recyclePending, inFlight=2

    // 旧作业持有的实例已被轮换 —— 迟到释放必须被忽略(否则 inFlight 被多扣)
    releaseFigureBrowser(fakeBrowser() as never)
    expect(browser.close, '迟到释放不得触发关闭').not.toHaveBeenCalled()
    releaseFigureBrowser(first as never) // inFlight=1, 仍不关
    expect(browser.close).not.toHaveBeenCalled()
    releaseFigureBrowser(second as never) // inFlight=0 → 关闭
    expect(browser.close).toHaveBeenCalledTimes(1)
  })

  test('回收阈值申请已到但仍有在途作业 → 不关闭;归零后才关闭', async () => {
    const browser = fakeBrowser()
    launch.mockResolvedValue(browser)

    for (let i = 0; i < 48; i++) {
      await acquireFigureBrowser('/chrome')
      releaseFigureBrowser()
    }
    const first = await acquireFigureBrowser('/chrome')   // jobs=49, inFlight=1
    const second = await acquireFigureBrowser('/chrome')  // jobs=50 → recyclePending, inFlight=2
    expect(first).toBe(second)
    expect(browser.close).not.toHaveBeenCalled()

    releaseFigureBrowser() // inFlight=1 — 仍不关
    expect(browser.close).not.toHaveBeenCalled()
    releaseFigureBrowser() // inFlight=0 → 关闭
    expect(browser.close).toHaveBeenCalledTimes(1)
  })
})
