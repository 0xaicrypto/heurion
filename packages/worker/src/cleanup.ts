/**
 * #1108 — rendered-artifact TTL cleanup.
 *
 * saveFile() 把每次渲染产物永久写在 workerDataDir()/output(+ 可选 S3 镜像);
 * job 元数据有压缩(#915),二进制产物却没有 → 磁盘无限增长。
 *
 * 分层安全设计(宁可留孤儿不可误删,与 deck-bytes 回滚同一哲学):
 *  - worker 是纯渲染面,无 DB 访问权,不知道哪些产物仍被服务端
 *    Doc.deckArtifactId / FigureRender 行引用 → 绝不按"引用"删,只按 TTL 删;
 *  - 仅删除 worker 自有命名(<uuid>_<fileName>)且 mtime 超过 TTL 的文件,
 *    陌生文件(人工放置/未来格式)一律跳过;
 *  - deck- 前缀默认保护 — deck 工件 id(server-ts deck-bytes.ts
 *    DECK_FILE_ID_PREFIX)被 Doc.deckArtifactId 永久引用,可能数月后仍被
 *    读取;figure_/preview_ 类产物可由同输入重渲染再生 → 可清理;
 *  - 保护前缀可用 WORKER_ARTIFACT_PROTECTED_PREFIXES 覆盖(逗号分隔)。
 *  - S3 镜像走同一 TTL:仅清理 renders/ 与 previews/ 前缀下的过期对象。
 */
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import { workerDataDir, loadJsonl } from './data-dir.js'
import { getS3 } from './storage.js'

const DEFAULT_TTL_DAYS = 30
export const DEFAULT_PROTECTED_PREFIXES = ['deck-']
const DEFAULT_S3_PREFIXES = ['renders', 'previews']

/** saveFile 的本地命名:<uuid>_<fileName>。非此形状的文件不归 worker 管。 */
export const WORKER_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_/i

/**
 * TTL 天数解析。语义:未设/垃圾值 → 默认 30;显式 0 或负数 → 关闭
 * (0 = 操作者明确想禁用;负数同样视为禁用,绝不变成"立即全删")。
 */
export function parseTtlDaysFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_TTL_DAYS
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_TTL_DAYS
  if (n <= 0) return 0
  return n
}

export function resolveTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return parseTtlDaysFromEnv(env.WORKER_ARTIFACT_TTL_DAYS) * 24 * 60 * 60 * 1000
}

export function resolveProtectedPrefixes(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.WORKER_ARTIFACT_PROTECTED_PREFIXES
  if (raw === undefined || raw.trim() === '') return [...DEFAULT_PROTECTED_PREFIXES]
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return list.length > 0 ? list : [...DEFAULT_PROTECTED_PREFIXES]
}

function isProtected(name: string, protectedPrefixes: string[]): boolean {
  return protectedPrefixes.some((p) => name.startsWith(p))
}

export interface CleanupSummary {
  /** 磁盘删除数 */
  deleted: number
  /** 磁盘释放字节 */
  bytes: number
  /** 命中保护前缀而保留数(含非 worker 命名的 deck- 文件) */
  keptProtected: number
  /** 非 worker 自有命名而跳过数(陌生文件,宁留不删) */
  skippedForeign: number
  /** stat/unlink 失败数 */
  errors: number
}

interface LocalFileManifestEntry {
  fileId: string
  path: string
  fileName: string
  mimeType: string
}

/** #1108: 清单同步剪枝 — 被删文件的 local-files.jsonl 条目一并移除,
 *  否则清单只增不减(重载时靠 existsSync 剔除是软防御,这里硬清理)。 */
function pruneManifest(dataDir: string, deletedPaths: Set<string>): void {
  if (deletedPaths.size === 0) return
  const manifestPath = join(dataDir, 'local-files.jsonl')
  if (!existsSync(manifestPath)) return
  const entries = loadJsonl<LocalFileManifestEntry>(manifestPath)
  const kept = entries.filter((e) => !e.path || !deletedPaths.has(e.path))
  if (kept.length === entries.length) return
  const lines = kept
    .map((e) => JSON.stringify({ fileId: e.fileId, path: e.path, fileName: e.fileName, mimeType: e.mimeType }))
    .join('\n')
  writeFileSync(manifestPath, lines ? lines + '\n' : '', 'utf-8')
}

/**
 * 磁盘 TTL 清理(fs 侧,可测)。opts.ttlMs 缺省读 env;opts.now 注入固定
 * 时钟供测试;opts.dataDir 覆盖 worker 数据目录。
 */
export function cleanupArtifacts(opts: {
  ttlMs?: number
  protectedPrefixes?: string[]
  now?: number
  dataDir?: string
} = {}): CleanupSummary {
  const now = opts.now ?? Date.now()
  const ttlMs = opts.ttlMs ?? resolveTtlMs()
  const protectedPrefixes = opts.protectedPrefixes ?? resolveProtectedPrefixes()
  const summary: CleanupSummary = { deleted: 0, bytes: 0, keptProtected: 0, skippedForeign: 0, errors: 0 }
  if (ttlMs <= 0) return summary

  const dataDir = opts.dataDir ?? workerDataDir()
  const outputDir = join(dataDir, 'output')
  if (!existsSync(outputDir)) return summary

  const cutoff = now - ttlMs
  const deletedPaths = new Set<string>()
  for (const name of readdirSync(outputDir)) {
    const full = join(outputDir, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(full)
    } catch {
      summary.errors++
      continue
    }
    if (!st.isFile()) continue
    // 保护判定用去 uuid 后的真实文件名(deck- 工件即使带 uuid 前缀也保护)
    const baseName = name.replace(WORKER_FILE_RE, '')
    if (isProtected(baseName, protectedPrefixes) || isProtected(name, protectedPrefixes)) {
      summary.keptProtected++
      continue
    }
    // 非 worker 自有命名 → 不归本进程管,宁可留孤儿
    if (!WORKER_FILE_RE.test(name)) {
      summary.skippedForeign++
      continue
    }
    if (st.mtimeMs >= cutoff) continue
    try {
      unlinkSync(full)
      summary.deleted++
      summary.bytes += st.size
      deletedPaths.add(full)
    } catch {
      summary.errors++
    }
  }
  pruneManifest(dataDir, deletedPaths)
  return summary
}

/**
 * S3 镜像同 TTL 清理。仅扫 renders/ 与 previews/ 前缀(deck 工件不经
 * worker 的 S3 通道落库,无需保护清单覆盖 S3 侧);未配置 S3 → 返回 null。
 */
export async function cleanupS3Artifacts(opts: {
  ttlMs?: number
  protectedPrefixes?: string[]
  prefixes?: string[]
  now?: number
} = {}): Promise<{ deleted: number; errors: number } | null> {
  const handle = getS3()
  if (!handle) return null
  const now = opts.now ?? Date.now()
  const ttlMs = opts.ttlMs ?? resolveTtlMs()
  if (ttlMs <= 0) return { deleted: 0, errors: 0 }
  const protectedPrefixes = opts.protectedPrefixes ?? resolveProtectedPrefixes()
  const prefixes = opts.prefixes ?? DEFAULT_S3_PREFIXES
  const cutoff = now - ttlMs
  let deleted = 0
  let errors = 0
  for (const prefix of prefixes) {
    let token: string | undefined
    do {
      let page
      try {
        page = await handle.client.send(new ListObjectsV2Command({
          Bucket: handle.bucket,
          Prefix: `${prefix}/`,
          MaxKeys: 1000,
          ContinuationToken: token,
        }))
      } catch {
        errors++
        break
      }
      const expired = (page.Contents ?? []).filter((o) =>
        o.Key &&
        o.LastModified instanceof Date &&
        o.LastModified.getTime() < cutoff &&
        !isProtected(o.Key.split('/').pop() ?? '', protectedPrefixes),
      )
      for (let i = 0; i < expired.length; i += 1000) {
        const batch = expired.slice(i, i + 1000)
        try {
          await handle.client.send(new DeleteObjectsCommand({
            Bucket: handle.bucket,
            Delete: { Objects: batch.map((o) => ({ Key: o.Key! })) },
          }))
          deleted += batch.length
        } catch {
          errors += batch.length
        }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
  }
  return { deleted, errors }
}

function logCleanup(line: string): void {
  console.log(`[ARTIFACT-CLEANUP] ${line}`)
}

/** 启动/定时统一入口:磁盘 + S3 同轮清理,汇总日志。 */
export async function runArtifactCleanup(opts: {
  ttlMs?: number
  protectedPrefixes?: string[]
  now?: number
} = {}): Promise<void> {
  const summary = cleanupArtifacts(opts)
  logCleanup(
    `disk: deleted=${summary.deleted} bytes=${summary.bytes} ` +
    `keptProtected=${summary.keptProtected} skippedForeign=${summary.skippedForeign} errors=${summary.errors}`,
  )
  const s3 = await cleanupS3Artifacts(opts)
  if (s3) logCleanup(`s3: deleted=${s3.deleted} errors=${s3.errors}`)
}

/**
 * worker 启动时跑一轮 + 按小时间隔定时跑。
 * WORKER_ARTIFACT_CLEANUP_INTERVAL_HOURS:未设/垃圾值 → 24;0/负 → 关闭
 * 定时(启动那一轮仍然执行)。返回 interval(已 unref)或 null。
 */
export function startArtifactCleanup(): NodeJS.Timeout | null {
  const raw = process.env.WORKER_ARTIFACT_CLEANUP_INTERVAL_HOURS
  let hours = 24
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw)
    if (Number.isFinite(n) && n <= 0) hours = 0
    else if (Number.isFinite(n)) hours = n
  }
  void runArtifactCleanup().catch((err: unknown) => {
    logCleanup(`startup run failed: ${(err as Error).message?.slice(0, 200)}`)
  })
  if (hours <= 0) {
    logCleanup('interval disabled (WORKER_ARTIFACT_CLEANUP_INTERVAL_HOURS <= 0)')
    return null
  }
  const timer = setInterval(() => {
    void runArtifactCleanup().catch((err: unknown) => {
      logCleanup(`interval run failed: ${(err as Error).message?.slice(0, 200)}`)
    })
  }, hours * 60 * 60 * 1000)
  timer.unref()
  return timer
}
