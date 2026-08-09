import fs from 'fs'
import path from 'path'

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
    this.cache = lines.map(line => JSON.parse(line))
    this.nextIdx = this.cache.length > 0
      ? Math.max(...this.cache.map(e => e.idx)) + 1
      : 1
  }

  /** #199: enqueue a file write; ordering is preserved by the queue. */
  private enqueueWrite(task: () => Promise<void>) {
    this.writeQueue = this.writeQueue.then(task).catch(err => {
      console.error('[event-log] write failed:', (err as Error).message)
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
      const snapshot = this.cache.map(e => JSON.stringify(e)).join('\n') + '\n'
      this.enqueueWrite(() => fs.promises.writeFile(this.filePath, snapshot, 'utf-8'))
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
