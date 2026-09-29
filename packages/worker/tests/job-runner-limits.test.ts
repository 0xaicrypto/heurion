import { describe, test, expect, vi, afterEach } from 'vitest'
import type { PersistentJobStore } from '../src/job-store.js'
import { parseQueueLimit, parseJobTimeoutMs } from '../src/job-runner.js'
import type { RenderJobType } from '@heurion/contracts'

/**
 * #1141 — job-runner 资源上界:
 *  - 单作业总时限(handler 挂起/死循环不再永久占槽);
 *  - 队列上限(积压时调用方立即拿到明确失败,不再无限排队)。
 */
function fakeStore() {
  const updates: Array<Record<string, unknown>> = []
  const store = {
    update: vi.fn((_id: string, patch: Record<string, unknown>) => { updates.push(patch) }),
    indexFile: vi.fn(),
  } as unknown as PersistentJobStore
  return { store, updates }
}

async function loadRunner(env: Record<string, string>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  return await import('../src/job-runner.js')
}

const TYPE = 'sidecar.generate_docx' as RenderJobType

afterEach(() => {
  delete process.env.WORKER_MAX_CONCURRENT
  delete process.env.WORKER_QUEUE_LIMIT
  delete process.env.WORKER_JOB_TIMEOUT_MS
  vi.restoreAllMocks()
})

describe('#1141 job-runner 资源上界', () => {
  test('parseQueueLimit / parseJobTimeoutMs:非法值 warn 回退默认,合法值透传', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const raw of ['0', '-2', 'abc', '', '  ']) {
      expect(parseQueueLimit(raw)).toBe(32)
      expect(parseJobTimeoutMs(raw)).toBe(300_000)
    }
    expect(parseQueueLimit(undefined)).toBe(32)
    expect(parseJobTimeoutMs(undefined)).toBe(300_000)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WORKER_QUEUE_LIMIT'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WORKER_JOB_TIMEOUT_MS'))
    warn.mockRestore()
    expect(parseQueueLimit('5')).toBe(5)
    expect(parseJobTimeoutMs('1500')).toBe(1500)
  })

  test('handler 超过总时限 → failed + 明确超时文案 + 槽位释放(后续作业能跑)', async () => {
    const { runJob } = await loadRunner({ WORKER_JOB_TIMEOUT_MS: '60', WORKER_MAX_CONCURRENT: '1' })
    const { store, updates } = fakeStore()

    await runJob({ jobStore: store, id: 'j1', type: TYPE, payload: {}, handler: () => new Promise(() => {}) })
    const failed = updates.find((u) => u.status === 'failed')
    expect(String(failed?.error)).toMatch(/timed out after 60ms/)

    // 槽位已释放:新作业可以立即执行(修复前永久占用 → 此处会挂起)。
    await runJob({ jobStore: store, id: 'j2', type: TYPE, payload: {}, handler: async () => ({ ok: true }) })
    expect(updates.filter((u) => u.status === 'completed').length).toBe(1)
  })

  test('队满 → 第三个作业立即 failed(QUEUE_FULL),不占槽位;前两个正常完成', async () => {
    const { runJob } = await loadRunner({ WORKER_MAX_CONCURRENT: '1', WORKER_QUEUE_LIMIT: '1', WORKER_JOB_TIMEOUT_MS: '60000' })
    const { store, updates } = fakeStore()

    let releaseFirst!: () => void
    const gate = new Promise<void>((r) => { releaseFirst = r })
    const first = runJob({ jobStore: store, id: 'j1', type: TYPE, payload: {}, handler: () => gate.then(() => ({ n: 1 })) })
    const second = runJob({ jobStore: store, id: 'j2', type: TYPE, payload: {}, handler: async () => ({ n: 2 }) })
    await runJob({ jobStore: store, id: 'j3', type: TYPE, payload: {}, handler: async () => ({ n: 3 }) })

    const failedIdx = updates.findIndex((u) => u.status === 'failed')
    expect(failedIdx).toBeGreaterThanOrEqual(0)
    expect(String(updates[failedIdx].error)).toMatch(/queue is full/)

    releaseFirst()
    await Promise.all([first, second])
    expect(updates.filter((u) => u.status === 'completed').length).toBe(2)
  })
})
