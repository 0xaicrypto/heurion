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

export function loadJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  const out: T[] = []
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as T)
      } catch { /* skip corrupted line */ }
    }
  } catch { /* unreadable — start fresh */ }
  return out
}

export function appendJsonl<T>(path: string, record: T): void {
  mkdirSync(workerDataDir(), { recursive: true })
  writeFileSync(path, JSON.stringify(record) + '\n', { flag: 'a' })
}
