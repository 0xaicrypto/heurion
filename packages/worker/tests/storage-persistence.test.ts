import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * #795 回归:本地存储模式的产物必须重启可取 —
 *  - localFiles 索引此前是纯内存 Map,worker 重启后 /files/:id/content 恒 404;
 *  - outputDir 此前在 os.tmpdir()(系统可清、不在卷上);
 *  - compose 挂了 worker-data:/data 却未设 WORKER_DATA_DIR,JSONL 落在容器层。
 * 修复:output 移入 workerDataDir()/output,索引持久化到 local-files.jsonl,
 * 模块加载时回放(文件已丢的条目剔除)。
 */
describe('worker local persistence (#795)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heurion-worker-test-'))
    process.env.WORKER_DATA_DIR = dir
  })

  afterEach(() => {
    delete process.env.WORKER_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
    vi.resetModules()
  })

  test('saveFile 落盘 + 索引写入 manifest,模块重载后 getLocalFile 仍可取', async () => {
    vi.resetModules()
    const { saveFile, getLocalFile } = await import('../src/storage.js')

    const saved = await saveFile(Buffer.from('render-bytes'), 'out.png', 'image/png', 'previews')
    const before = getLocalFile(saved.fileId)
    expect(before).not.toBeNull()
    expect(existsSync(before!.path)).toBe(true)
    expect(readFileSync(before!.path, 'utf-8')).toBe('render-bytes')

    // 模拟 worker 重启:清模块缓存后重新加载
    vi.resetModules()
    const { getLocalFile: getAfterRestart } = await import('../src/storage.js')
    const after = getAfterRestart(saved.fileId)
    expect(after).not.toBeNull()
    expect(after!.path).toBe(before!.path)
    expect(after!.fileName).toBe('out.png')
    // 输出目录在 WORKER_DATA_DIR 下(不再 tmpdir)
    expect(after!.path.startsWith(join(dir, 'output'))).toBe(true)
  })

  test('manifest 中文件已丢失的条目在重载时被剔除', async () => {
    vi.resetModules()
    const { saveFile } = await import('../src/storage.js')
    const saved = await saveFile(Buffer.from('x'), 'gone.png', 'image/png')
    const before = await import('../src/storage.js')
    rmSync(before.getLocalFile(saved.fileId)!.path)

    vi.resetModules()
    const { getLocalFile } = await import('../src/storage.js')
    expect(getLocalFile(saved.fileId)).toBeNull()
  })
})
