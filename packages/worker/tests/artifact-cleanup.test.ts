import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, utimesSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'

/**
 * #1108 回归:渲染产物无 TTL → 磁盘无限增长。
 * cleanupArtifacts 按前缀分类 + mtime TTL 清理:
 *  - 旧的 worker 自有命名(<uuid>_<name>)非保护前缀 → 删;
 *  - deck- 前缀(被 Doc.deckArtifactId 永久引用)→ 旧也保留;
 *  - 新文件 → 保留;
 *  - 陌生命名(非 worker 自有)→ 宁留不删;
 *  - 被删文件从 local-files.jsonl 同步剪枝。
 */

// S3 侧测试:storage 模块的 getS3 返回假 client,send 按用例注入行为
//(真实 storage 模块在无 S3_ENDPOINT 时 getS3()=null,侧不到批量删除路径)。
const s3Mock = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('../src/storage.js', () => ({
  getS3: () => ({ client: { send: s3Mock.send }, bucket: 'test-bucket' }),
}))

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const UUID = '123e4567-e89b-12d3-a456-426614174000'
const UUID2 = '987e4567-e89b-12d3-a456-426614174999'

let dir: string

function seed(name: string, ageMs: number, content = 'x'): string {
  const out = join(dir, 'output')
  mkdirSync(out, { recursive: true })
  const full = join(out, name)
  writeFileSync(full, content)
  const old = new Date(NOW - ageMs)
  utimesSync(full, old, old)
  return full
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'heurion-artifact-cleanup-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function run(opts: Record<string, unknown> = {}) {
  const { cleanupArtifacts } = await import('../src/cleanup.js')
  return cleanupArtifacts({ dataDir: dir, now: NOW, ...opts })
}

describe('artifact TTL cleanup (#1108)', () => {
  test('旧的非保护 worker 产物被删,新文件保留', async () => {
    const oldPptx = seed(`${UUID}_presentation.pptx`, 40 * DAY_MS)
    const oldPdf = seed(`${UUID2}_document.pdf`, 31 * DAY_MS, 'pdf-bytes')
    const recent = seed(`${UUID}_chart.svg`, 5 * DAY_MS)

    const summary = await run({ ttlMs: 30 * DAY_MS })

    expect(summary.deleted).toBe(2)
    expect(summary.bytes).toBe('x'.length + 'pdf-bytes'.length)
    expect(existsSync(oldPptx)).toBe(false)
    expect(existsSync(oldPdf)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(summary.keptProtected).toBe(0)
  })

  test('deck- 前缀旧文件保留(被 Doc.deckArtifactId 引用,默认保护)', async () => {
    const oldDeck = seed(`${UUID}_deck-doc42-1700000000000.pptx`, 400 * DAY_MS)
    const oldOther = seed(`${UUID}_document.pdf`, 400 * DAY_MS)

    const summary = await run({ ttlMs: 30 * DAY_MS })

    expect(existsSync(oldDeck)).toBe(true)
    expect(existsSync(oldOther)).toBe(false)
    expect(summary.keptProtected).toBe(1)
    expect(summary.deleted).toBe(1)
  })

  test('边界:mtime 恰好等于 cutoff 的文件保留(>= cutoff 不删)', async () => {
    const boundary = seed(`${UUID}_document.pdf`, 30 * DAY_MS)
    await run({ ttlMs: 30 * DAY_MS })
    expect(existsSync(boundary)).toBe(true)
  })

  test('陌生命名(非 <uuid>_<name>)跳过不删 — 宁留孤儿不误删', async () => {
    const foreign = seed('manual-note.txt', 400 * DAY_MS)
    const summary = await run({ ttlMs: 30 * DAY_MS })
    expect(existsSync(foreign)).toBe(true)
    expect(summary.skippedForeign).toBe(1)
    expect(summary.deleted).toBe(0)
  })

  test('自定义保护前缀完全替换默认:deck- 不再保护,figure. 受保护', async () => {
    const oldDeck = seed(`${UUID}_deck-x.pptx`, 400 * DAY_MS)
    const oldFig = seed(`${UUID}_figure.svg`, 400 * DAY_MS)
    const summary = await run({ ttlMs: 30 * DAY_MS, protectedPrefixes: ['figure.'] })
    expect(existsSync(oldDeck)).toBe(false)
    expect(existsSync(oldFig)).toBe(true)
    expect(summary.deleted).toBe(1)
    expect(summary.keptProtected).toBe(1)
  })

  test('ttlMs<=0 → 什么都不删(显式关闭语义)', async () => {
    const old = seed(`${UUID}_document.pdf`, 400 * DAY_MS)
    const summary = await run({ ttlMs: 0 })
    expect(existsSync(old)).toBe(true)
    expect(summary.deleted).toBe(0)
  })

  test('被删文件从 local-files.jsonl 剪枝,幸存条目保留', async () => {
    seed(`${UUID}_gone.pdf`, 400 * DAY_MS)
    const keptPath = seed(`${UUID}_kept.pdf`, 1 * DAY_MS)
    writeFileSync(join(dir, 'local-files.jsonl'), [
      JSON.stringify({ fileId: 'a', path: join(dir, 'output', `${UUID}_gone.pdf`), fileName: 'gone.pdf', mimeType: 'application/pdf' }),
      JSON.stringify({ fileId: 'b', path: keptPath, fileName: 'kept.pdf', mimeType: 'application/pdf' }),
      JSON.stringify({ fileId: 'c', path: '/elsewhere/dead.png', fileName: 'dead.png', mimeType: 'image/png' }),
    ].join('\n') + '\n')

    await run({ ttlMs: 30 * DAY_MS })

    const lines = readFileSync(join(dir, 'local-files.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.length).toBe(2)
    expect(lines.some((e: { fileId: string }) => e.fileId === 'a')).toBe(false)
    expect(lines.some((e: { fileId: string }) => e.fileId === 'b')).toBe(true)
  })

  test('output 目录不存在 → 空汇总不抛', async () => {
    const summary = await run({ ttlMs: 30 * DAY_MS })
    expect(summary).toEqual({ deleted: 0, bytes: 0, keptProtected: 0, skippedForeign: 0, errors: 0 })
  })
})

describe('env TTL 解析 (#1108)', () => {
  afterEach(() => {
    delete process.env.WORKER_ARTIFACT_TTL_DAYS
    delete process.env.WORKER_ARTIFACT_PROTECTED_PREFIXES
  })

  test('未设 → 默认 30 天;垃圾值 → 默认;0/负 → 0(关闭)', async () => {
    const m = await import('../src/cleanup.js')
    expect(m.resolveTtlMs({} as NodeJS.ProcessEnv)).toBe(30 * DAY_MS)
    expect(m.resolveTtlMs({ WORKER_ARTIFACT_TTL_DAYS: 'nonsense' } as NodeJS.ProcessEnv)).toBe(30 * DAY_MS)
    expect(m.resolveTtlMs({ WORKER_ARTIFACT_TTL_DAYS: '0' } as NodeJS.ProcessEnv)).toBe(0)
    expect(m.resolveTtlMs({ WORKER_ARTIFACT_TTL_DAYS: '-3' } as NodeJS.ProcessEnv)).toBe(0)
    expect(m.resolveTtlMs({ WORKER_ARTIFACT_TTL_DAYS: '7' } as NodeJS.ProcessEnv)).toBe(7 * DAY_MS)
  })

  test('保护前缀 env:未设 → [deck-];空串/纯逗号 → 回落默认;自定义生效', async () => {
    const m = await import('../src/cleanup.js')
    expect(m.resolveProtectedPrefixes({} as NodeJS.ProcessEnv)).toEqual(['deck-'])
    expect(m.resolveProtectedPrefixes({ WORKER_ARTIFACT_PROTECTED_PREFIXES: '' } as NodeJS.ProcessEnv)).toEqual(['deck-'])
    expect(m.resolveProtectedPrefixes({ WORKER_ARTIFACT_PROTECTED_PREFIXES: ' , ' } as NodeJS.ProcessEnv)).toEqual(['deck-'])
    expect(m.resolveProtectedPrefixes({ WORKER_ARTIFACT_PROTECTED_PREFIXES: 'deck-, report_' } as NodeJS.ProcessEnv)).toEqual(['deck-', 'report_'])
  })

  test('默认保护前缀引用 contracts 权威常量(跨包单源 — server 改前缀 worker 自动跟随)', async () => {
    const m = await import('../src/cleanup.js')
    const contracts = await import('@heurion/contracts')
    expect(m.DEFAULT_PROTECTED_PREFIXES).toEqual([contracts.DECK_FILE_ID_PREFIX])
  })
})

describe('S3 镜像 TTL 清理 (#1108)', () => {
  beforeEach(() => {
    s3Mock.send.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('DeleteObjects 部分失败:deleted 只计真正删除的 key,失败逐条记录(partial 不抛)', async () => {
    const { cleanupS3Artifacts } = await import('../src/cleanup.js')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    s3Mock.send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof ListObjectsV2Command) {
        // 扫描覆盖 renders/ 与 previews/ 两个前缀 — 只在 renders/ 放对象。
        if (cmd.input.Prefix !== 'renders/') return { Contents: [], IsTruncated: false }
        return {
          Contents: [
            { Key: 'renders/aaa/old.png', LastModified: new Date(NOW - 40 * DAY_MS) },
            { Key: 'renders/bbb/old2.png', LastModified: new Date(NOW - 40 * DAY_MS) },
            { Key: 'renders/ccc/fresh.png', LastModified: new Date(NOW - 1 * DAY_MS) },
          ],
          IsTruncated: false,
        }
      }
      if (cmd instanceof DeleteObjectsCommand) {
        // 模拟 S3「不抛但部分失败」:一个 key AccessDenied,响应带 Errors。
        const keys = (cmd.input.Delete?.Objects ?? []).map((o) => o.Key)
        return {
          Deleted: keys.filter((k) => k !== 'renders/bbb/old2.png').map((Key) => ({ Key })),
          Errors: [{ Key: 'renders/bbb/old2.png', Code: 'AccessDenied', Message: 'Access Denied' }],
        }
      }
      throw new Error(`unexpected command: ${(cmd as object).constructor.name}`)
    })

    const res = await cleanupS3Artifacts({ ttlMs: 30 * DAY_MS, now: NOW })

    // 2 个过期对象进入批量删除:1 成功 1 失败(第三个未过期,不进批次)。
    expect(res).toEqual({ deleted: 1, errors: 1 })
    // 批量删除只携带过期对象(不含 fresh)。
    const deleteCmd = s3Mock.send.mock.calls
      .map((c) => c[0])
      .find((c: unknown) => c instanceof DeleteObjectsCommand) as DeleteObjectsCommand
    expect(deleteCmd.input.Delete?.Objects).toHaveLength(2)
    // 逐对象失败日志:key + message。
    const failureLine = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('s3 delete failed'))
    expect(failureLine).toContain('renders/bbb/old2.png')
    expect(failureLine).toContain('Access Denied')
  })

  test('DeleteObjects 整批抛错 → 整批计 errors(原语义保持)', async () => {
    const { cleanupS3Artifacts } = await import('../src/cleanup.js')
    s3Mock.send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof ListObjectsV2Command) {
        if (cmd.input.Prefix !== 'renders/') return { Contents: [], IsTruncated: false }
        return {
          Contents: [{ Key: 'renders/aaa/old.png', LastModified: new Date(NOW - 40 * DAY_MS) }],
          IsTruncated: false,
        }
      }
      throw new Error('network down')
    })

    const res = await cleanupS3Artifacts({ ttlMs: 30 * DAY_MS, now: NOW })
    expect(res).toEqual({ deleted: 0, errors: 1 })
  })
})

