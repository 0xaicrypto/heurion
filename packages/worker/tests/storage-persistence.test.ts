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

/**
 * #915 回归:local-files.jsonl 压缩 — append-only 清单此前无限增长;
 * 同 fileId 应只保留最新记录(map 为权威态),写满阈值触发重写。
 */
describe('local-files.jsonl compaction (#915)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heurion-worker-compact-'))
    process.env.WORKER_DATA_DIR = dir
  })

  afterEach(() => {
    delete process.env.WORKER_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
    vi.resetModules()
  })

  const readManifest = (): Array<{ fileId: string; path: string; fileName: string }> =>
    readFileSync(join(dir, 'local-files.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))

  test('compactLocalFiles:同 fileId 去重保最新,重载后仍可取', async () => {
    vi.resetModules()
    const { saveFile, compactLocalFiles, getLocalFile } = await import('../src/storage.js')
    const { appendJsonl } = await import('../src/data-dir.js')
    const a = await saveFile(Buffer.from('a'), 'a.png', 'image/png')
    const b = await saveFile(Buffer.from('b'), 'b.png', 'image/png')
    const aBefore = getLocalFile(a.fileId)!

    // 模拟 append-only 日志增长:同 fileId 追加已被取代的旧记录(死路径)
    const stale = { fileId: a.fileId, path: '/gone/old-a.png', fileName: 'old-a.png', mimeType: 'image/png' }
    appendJsonl(join(dir, 'local-files.jsonl'), stale)
    appendJsonl(join(dir, 'local-files.jsonl'), { ...stale, path: '/gone/old-a2.png' })

    compactLocalFiles()
    const lines = readManifest()
    expect(lines.length).toBe(2) // 压缩后每 fileId 恰一行,map 为权威态
    const aLine = lines.find((e) => e.fileId === a.fileId)
    expect(aLine?.path).toBe(aBefore.path)
    expect(aLine?.fileName).toBe('a.png')

    // 重载(模拟重启):两份产物仍可取
    vi.resetModules()
    const { getLocalFile: getAfterRestart } = await import('../src/storage.js')
    expect(getAfterRestart(a.fileId)?.fileName).toBe('a.png')
    expect(getAfterRestart(b.fileId)?.fileName).toBe('b.png')
  })

  test('saveFile 写满阈值自动触发压缩', async () => {
    vi.resetModules()
    const { saveFile } = await import('../src/storage.js')
    for (let i = 0; i < 200; i++) {
      await saveFile(Buffer.from(String(i)), `out-${i}.png`, 'image/png')
    }
    // 200 次写入 = 200 个唯一 fileId → 压缩后恰好 200 行(无重复增长)
    expect(readManifest().length).toBe(200)
  })
})
