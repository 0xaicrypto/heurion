/**
 * #795 — the worker's single persistent-data location.
 *
 * `WORKER_DATA_DIR` wins (the compose file mounts worker-data:/data and sets
 * WORKER_DATA_DIR=/data); default is `<cwd>/.worker-data` for bare runs.
 * Previously storage.ts dropped files in os.tmpdir() and the local-file
 * index lived in a plain Map — a worker restart lost every produced file.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync } from 'fs'
import { join, dirname, basename } from 'path'

export function workerDataDir(): string {
  return process.env.WORKER_DATA_DIR || join(process.cwd(), '.worker-data')
}

let atomicSeq = 0

/**
 * P1: 原子整体重写 — JSONL 压缩（jobs.jsonl/files.jsonl/local-files.jsonl）
 * 此前直接 writeFileSync 原地覆盖：写入中途崩溃/断电会把日志留成半截，
 * 压缩即"删掉"其他记录。现在同目录临时文件 → fsync → rename（POSIX
 * rename 原子），旧文件在 rename 前始终完整。
 */
export function atomicWriteFileSync(filePath: string, data: string): void {
  atomicSeq = (atomicSeq + 1) % 1_000_000
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = join(dirname(filePath), `.${basename(filePath)}.tmp-${process.pid}-${atomicSeq}`)
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, filePath)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* 清理 best-effort */ }
    throw err
  }
}

/** JSONL 内容解析（跳过空行/损坏行）— loadJsonl 与 cleanup.pruneManifest
 *  共用的单一实现（复审轮 2 收敛：容错细节不再两处分叉）。 */
export function parseJsonlContent<T>(content: string): T[] {
  const out: T[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch { /* skip corrupted line */ }
  }
  return out
}

export function loadJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  try {
    return parseJsonlContent<T>(readFileSync(path, 'utf-8'))
  } catch { /* unreadable — start fresh */ }
  return []
}

export function appendJsonl<T>(path: string, record: T): void {
  mkdirSync(workerDataDir(), { recursive: true })
  writeFileSync(path, JSON.stringify(record) + '\n', { flag: 'a' })
}
