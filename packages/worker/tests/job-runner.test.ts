import { describe, test, expect, vi, afterEach } from 'vitest'
import { parseMaxConcurrentJobs, runJob } from '../src/job-runner.js'
import type { PersistentJobStore } from '../src/job-store.js'

/**
 * #928 job-runner 卫生:
 *  - WORKER_MAX_CONCURRENT 非法值(0/负数/NaN)此前静默产生 MAX=0/NaN,
 *    whenSlotFree 的比较恒 false → 作业永久排队且无日志;现在 clamp 回退 4。
 *  - callback_url 此前不校验 scheme 直接 fetch(相对路径抛 TypeError 被
 *    吞,畸形 scheme 无意义出网);现在只放行 http/https,且带 30s 超时。
 */
function fakeStore(): PersistentJobStore {
  return { update: vi.fn(), indexFile: vi.fn() } as unknown as PersistentJobStore
}

describe('#928 WORKER_MAX_CONCURRENT clamp', () => {
  test('0/负数/非数字/空值 → warn 并回退默认 4', () => {
    for (const raw of ['0', '-2', 'abc', '', '  ', undefined]) {
      expect(parseMaxConcurrentJobs(raw)).toBe(4)
    }
    // 合法值透传
    expect(parseMaxConcurrentJobs('7')).toBe(7)
    expect(parseMaxConcurrentJobs('1')).toBe(1)
  })
})

describe('#928 callback_url 校验与超时', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('非 http/https scheme → 跳过 notify,不发起 fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await runJob({ jobStore: fakeStore(), id: 'j1', type: 'sidecar.render_table', payload: {}, handler: async () => ({}), callbackUrl: 'ftp://evil/hook' })
    await runJob({ jobStore: fakeStore(), id: 'j2', type: 'sidecar.render_table', payload: {}, handler: async () => ({}), callbackUrl: '/api/v1/files/proxy' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('合法 https callback → 发起 fetch 且带 AbortSignal 超时', async () => {
    const fetchMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('fetch', fetchMock)
    await runJob({ jobStore: fakeStore(), id: 'j3', type: 'sidecar.render_table', payload: {}, handler: async () => ({}), callbackUrl: 'https://cb.example.com/hook' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://cb.example.com/hook')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.method).toBe('POST')
  })

  test('未提供 callback_url → 不 fetch,作业状态照常流转', async () => {
    const fetchMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('fetch', fetchMock)
    const store = fakeStore()
    await runJob({ jobStore: store, id: 'j4', type: 'sidecar.render_table', payload: {}, handler: async () => ({ file_id: 'f1' }) })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.update).toHaveBeenCalledWith('j4', expect.objectContaining({ status: 'completed' }))
  })
})

/**
 * #926 回归网 — 并发上限行为:MAX=2 时第 3 个作业必须排队,任一在跑作业
 * 完成后才启动。MAX_CONCURRENT_JOBS 是模块加载期常量(与 job-store.test.ts
 * 同一注入模式):resetModules + 环境变量注入 → 动态 import 取新模块实例。
 */
describe('#926 并发上限行为', () => {
  test('MAX=2:前 2 个立即启动,第 3 个排队,完成一个才启动', async () => {
    vi.resetModules()
    process.env.WORKER_MAX_CONCURRENT = '2'
    try {
      const { runJob: runJobCapped } = await import('../src/job-runner.js')
      const store = fakeStore()
      const started: string[] = []
      const gate = () => {
        let resolve!: () => void
        const promise = new Promise<void>((r) => { resolve = r })
        return { promise, resolve }
      }
      const g = [gate(), gate(), gate()]
      const run = (id: string, g0: ReturnType<typeof gate>) => runJobCapped({
        jobStore: store,
        id,
        type: 'sidecar.render_table',
        payload: {},
        handler: async () => {
          started.push(id)
          await g0.promise
          return { file_id: id }
        },
      })
      const all = [run('a', g[0]), run('b', g[1]), run('c', g[2])]

      // 微任务冲刷:a/b 占满 2 个槽位,c 仍在 whenSlotFree 排队。
      await new Promise((r) => setTimeout(r, 5))
      expect(started).toEqual(['a', 'b'])
      expect(store.update).toHaveBeenCalledTimes(2)
      expect(store.update).toHaveBeenNthCalledWith(1, 'a', expect.objectContaining({ status: 'running' }))
      expect(store.update).toHaveBeenNthCalledWith(2, 'b', expect.objectContaining({ status: 'running' }))

      // a 完成 → 槽位释放 → c 立即启动。
      g[0].resolve()
      await new Promise((r) => setTimeout(r, 5))
      expect(started).toEqual(['a', 'b', 'c'])

      g[1].resolve()
      g[2].resolve()
      await Promise.all(all)
      expect(store.update).toHaveBeenCalledWith('c', expect.objectContaining({ status: 'completed' }))
    } finally {
      delete process.env.WORKER_MAX_CONCURRENT
      vi.resetModules()
    }
  })
})
