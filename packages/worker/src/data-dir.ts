/**
 * #795 — the worker's single persistent-data location.
 *
 * `WORKER_DATA_DIR` wins (the compose file mounts worker-data:/data and sets
 * WORKER_DATA_DIR=/data); default is `<cwd>/.worker-data` for bare runs.
 * Previously storage.ts dropped files in os.tmpdir() and the local-file
 * index lived in a plain Map — a worker restart lost every produced file.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

export function workerDataDir(): string {
  return process.env.WORKER_DATA_DIR || join(process.cwd(), '.worker-data')
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
