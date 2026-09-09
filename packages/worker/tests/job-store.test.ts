import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * #915 回归:jobs.jsonl / files.jsonl 的加载与压缩卫生 —
 *  - recoverInterrupted 追加的 { __recovered } marker 行此前被当 JobRecord
 *    set(undefined);
 *  - 崩溃时仍为 pending 的作业重启后永远 pending;
 *  - 压缩此前只覆盖 jobs.jsonl,files 清单无限增长。
 * WORKER_DATA_DIR 需在模块加载前注入(job-store 在 import 期解析路径)。
 */
describe('worker job store persistence (#915)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heurion-jobstore-test-'))
    process.env.WORKER_DATA_DIR = dir
  })

  afterEach(() => {
    delete process.env.WORKER_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
    vi.resetModules()
  })

  const readJsonl = (name: string): any[] =>
    readFileSync(join(dir, name), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))

  test('含 __recovered 标记行的 jsonl 重载不产生 undefined 作业', async () => {
    vi.resetModules()
    const { appendJsonl } = await import('../src/data-dir.js')
    appendJsonl(join(dir, 'jobs.jsonl'), { id: 'j1', type: 'sidecar.generate_pptx', status: 'completed', created_at: 1 })
    appendJsonl(join(dir, 'jobs.jsonl'), { __recovered: 1, at: 2 })

    const { PersistentJobStore } = await import('../src/job-store.js')
    const store = new PersistentJobStore()
    expect(store.get('j1')?.status).toBe('completed')
    // 修复前:marker 行被 set(undefined),作业表多出一个无 id 记录
    expect((store as any).jobs.size).toBe(1)
  })

  test('压缩不会把无 id 的 marker 行写回', async () => {
    vi.resetModules()
    const { appendJsonl } = await import('../src/data-dir.js')
    appendJsonl(join(dir, 'jobs.jsonl'), { id: 'j1', type: 'x', status: 'running', created_at: 1 })
    appendJsonl(join(dir, 'jobs.jsonl'), { __recovered: 1, at: 2 })

    const { PersistentJobStore } = await import('../src/job-store.js')
    const store = new PersistentJobStore()
    store.recoverInterrupted()
    // 写满阈值触发压缩(200 次 update),重写内容只来自内存 map
    for (let i = 0; i < 200; i++) store.update('j1', {})
    const lines = readJsonl('jobs.jsonl')
    expect(lines.length).toBe(1)
    expect(lines[0].id).toBe('j1')
    expect(lines[0].__recovered).toBeUndefined()
  })

  test('pending 作业重启后被标 failed(不再永远 pending)', async () => {
    vi.resetModules()
    const { appendJsonl } = await import('../src/data-dir.js')
    appendJsonl(join(dir, 'jobs.jsonl'), { id: 'j2', type: 'x', status: 'pending', created_at: 1 })
    appendJsonl(join(dir, 'jobs.jsonl'), { id: 'j3', type: 'x', status: 'running', created_at: 2 })
    appendJsonl(join(dir, 'jobs.jsonl'), { id: 'j4', type: 'x', status: 'completed', created_at: 3 })

    const { PersistentJobStore } = await import('../src/job-store.js')
    const store = new PersistentJobStore()
    expect(store.recoverInterrupted()).toBe(2) // j2 + j3,j4 不受影响
    for (const id of ['j2', 'j3']) {
      const job = store.get(id)
      expect(job?.status).toBe('failed')
      expect(job?.error).toBe('Interrupted by worker restart')
      expect(job?.completed_at).toBeTruthy()
    }
    expect(store.get('j4')?.status).toBe('completed')
  })

  test('files.jsonl 压缩:同 fileId 保留最新记录', async () => {
    vi.resetModules()
    const { PersistentJobStore } = await import('../src/job-store.js')
    const store = new PersistentJobStore()
    const ids = ['f1', 'f2', 'f3']
    // round-robin 覆写 200 次触发压缩阈值;最后一次写入 i=198/199/200
    // → f1/f2/f3 的最新版本分别为 v198/v199/v200
    for (let i = 1; i <= 200; i++) {
      store.indexFile({ fileId: ids[i % 3], jobId: 'job', fileName: `v${i}.bin`, mimeType: 'application/octet-stream' })
    }
    const lines = readJsonl('files.jsonl')
    expect(lines.length).toBe(3) // 每 fileId 恰一行
    const byId = new Map<string, any>(lines.map((e) => [e.fileId, e]))
    expect(byId.get('f1')?.fileName).toBe('v198.bin')
    expect(byId.get('f2')?.fileName).toBe('v199.bin')
    expect(byId.get('f3')?.fileName).toBe('v200.bin')

    // 重载(模拟重启):索引为最新版本,且后续追加照常工作
    vi.resetModules()
    const { PersistentJobStore: ReloadedStore } = await import('../src/job-store.js')
    const reloaded = new ReloadedStore()
    expect(reloaded.getFileEntry('f2')?.fileName).toBe('v199.bin')
    reloaded.indexFile({ fileId: 'f4', jobId: 'job', fileName: 'v1.bin', mimeType: 'application/octet-stream' })
    expect(readJsonl('files.jsonl').length).toBe(4)
    expect(reloaded.getFileEntry('f4')).not.toBeNull()
  })
})
