import fs from 'fs'
import path from 'path'
import { makeLogger } from '../common/logger.js'
import { atomicWriteFile, atomicWriteFileSync } from '../common/fs-atomic.js'

const log = makeLogger('event-log')

export interface Event {
  idx: number
  timestamp: number
  eventType: string
  content: string
  metadata: Record<string, unknown>
  agentId: string
  sessionId: string
}

/**
 * Append-only event log backed by JSONL file.
 * Each line is a JSON object — same format as the Python WriteAheadLog.
 * For production use, the Python SDK's SQLite EventLog is the source of truth;
 * this is a lightweight TS-native equivalent for dev/test/standalone mode.
 *
 * #199: writes go through a serialized async queue (fs.promises.appendFile)
 * so a busy turn (dozens of tool events) never blocks the event loop; the
 * queue is flushed on close(). Reads stay synchronous over the in-memory
 * cache.
 */
export class EventLog {
  private filePath: string
  private agentId: string
  private cache: Event[] = []
  private nextIdx: number = 1
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(baseDir: string, agentId: string) {
    fs.mkdirSync(baseDir, { recursive: true })
    this.filePath = path.join(baseDir, 'event_log.jsonl')
    this.agentId = agentId
    this.load()
  }

  private load() {
    if (!fs.existsSync(this.filePath)) return
    const lines = fs.readFileSync(this.filePath, 'utf-8').split('\n').filter(Boolean)
    // P1: 崩溃/断电可能在 JSONL 尾部留下半行 — 逐行容错跳过损坏行
    // （此前整体 JSON.parse，一行截断就让整个账号的 EventLog 构造抛错 → 500），
    // 有效事件与 nextIdx 仍以文件内最大 idx 续号。
    let skipped = 0
    const parsed: Event[] = []
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line))
      } catch {
        skipped++
      }
    }
    this.cache = parsed
    this.nextIdx = this.cache.length > 0
      ? Math.max(...this.cache.map(e => e.idx)) + 1
      : 1
    if (skipped > 0) {
      log.warn(`[event-log] skipped ${skipped} corrupt line(s) (partial write?) — rewriting clean log`)
      // 自愈：半行若留在文件里，后续 append 会拼在它后面继续制造坏行 —
      // 构造时用原子重写把有效事件固化回干净的 JSONL。
      try {
        atomicWriteFileSync(this.filePath, this.cache.map(e => JSON.stringify(e)).join('\n') + '\n')
      } catch (err) {
        log.error('[event-log] corrupt-tail rewrite failed:', (err as Error).message)
      }
    }
  }

  /** #199: enqueue a file write; ordering is preserved by the queue. */
  private enqueueWrite(task: () => Promise<void>) {
    this.writeQueue = this.writeQueue.then(task).catch(err => {
      log.error('[event-log] write failed:', (err as Error).message)
    })
  }

  append(event: Omit<Event, 'idx'>): Event {
    const full: Event = { ...event, idx: this.nextIdx++, agentId: event.agentId || this.agentId }
    this.cache.push(full)
    const line = JSON.stringify(full) + '\n'
    this.enqueueWrite(() => fs.promises.appendFile(this.filePath, line, 'utf-8'))
    return full
  }

  query(opts: {
    sessionId?: string
    eventType?: string
    limit?: number
    afterIdx?: number
  }): Event[] {
    let results = [...this.cache]
    if (opts.sessionId) results = results.filter(e => e.sessionId === opts.sessionId)
    if (opts.eventType) results = results.filter(e => e.eventType === opts.eventType)
    if (opts.afterIdx !== undefined && opts.afterIdx !== null) results = results.filter(e => e.idx > opts.afterIdx!)
    results.sort((a, b) => b.idx - a.idx)
    if (opts.limit) results = results.slice(0, opts.limit)
    return results
  }

  count(): number {
    return this.cache.length
  }

  deleteSession(sessionId: string): number {
    const before = this.cache.length
    this.cache = this.cache.filter(e => e.sessionId !== sessionId)
    const removed = before - this.cache.length
    if (removed > 0) {
      // #199: full rewrite is async (rare operation; never blocks a turn).
      // P1: 原子重写 — 临时文件 + rename，崩溃不会留下半截日志。
      const snapshot = this.cache.map(e => JSON.stringify(e)).join('\n') + '\n'
      this.enqueueWrite(() => atomicWriteFile(this.filePath, snapshot))
    }
    return removed
  }

  /** #199: await pending writes (called on shutdown / tests). */
  async flush(): Promise<void> {
    await this.writeQueue
  }

  close() {
    void this.flush()
  }
}
