import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq'
import Redis, { type RedisOptions } from 'ioredis'

export interface EvolutionJob {
  userId: string
  sessionId: string
  userMessage: string
  patientHash?: string
}

export type EvolutionJobProcessor = (job: EvolutionJob) => Promise<void>

export interface QueueMetrics {
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
  paused: number
}

export interface EvolutionQueue {
  readonly type: 'in-memory' | 'bullmq'
  add(job: EvolutionJob): Promise<void>
  close(): Promise<void>
  getMetrics(): Promise<QueueMetrics>
}

/**
 * In-memory queue for unit tests and offline mode.
 * Jobs are processed fire-and-forget by the registered processor.
 */
export class InMemoryEvolutionQueue implements EvolutionQueue {
  readonly type = 'in-memory' as const
  private processor?: EvolutionJobProcessor
  public readonly jobs: EvolutionJob[] = []

  setProcessor(processor: EvolutionJobProcessor) {
    this.processor = processor
  }

  async add(job: EvolutionJob): Promise<void> {
    this.jobs.push(job)
    if (this.processor) {
      this.processor(job).catch(err => console.error('[EVOLUTION] In-memory processor failed:', err))
    }
  }

  async close(): Promise<void> {}

  async getMetrics(): Promise<QueueMetrics> {
    return {
      waiting: this.jobs.length,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
    }
  }
}

function getQueueDefaultJobOptions(): JobsOptions {
  return {
    attempts: parseInt(process.env.EVOLUTION_JOB_ATTEMPTS || '3', 10),
    backoff: {
      type: (process.env.EVOLUTION_JOB_BACKOFF_TYPE || 'exponential') as 'exponential' | 'fixed',
      delay: parseInt(process.env.EVOLUTION_JOB_BACKOFF_DELAY || '5000', 10),
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  }
}

/**
 * Production queue backed by BullMQ + Redis.
 */
export class BullMqEvolutionQueue implements EvolutionQueue {
  readonly type = 'bullmq' as const
  private queue: Queue
  public readonly connection: ConnectionOptions

  constructor(
    public readonly name: string,
    connection: ConnectionOptions,
  ) {
    this.connection = connection
    this.queue = new Queue(name, { connection, defaultJobOptions: getQueueDefaultJobOptions() })
  }

  async add(job: EvolutionJob): Promise<void> {
    await this.queue.add('evolution-turn', job)
  }

  async close(): Promise<void> {
    await this.queue.close()
  }

  async getMetrics(): Promise<QueueMetrics> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused')
    return {
      waiting: counts.waiting || 0,
      active: counts.active || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      delayed: counts.delayed || 0,
      paused: counts.paused || 0,
    }
  }
}

export function parseRedisUrl(url?: string): ConnectionOptions | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    const opts: ConnectionOptions = {
      host: parsed.hostname,
      port: parseInt(parsed.port || '6379', 10),
    }
    if (parsed.username) opts.username = decodeURIComponent(parsed.username)
    if (parsed.password) opts.password = decodeURIComponent(parsed.password)
    if (parsed.protocol === 'rediss:') opts.tls = {}

    const dbFromQuery = parsed.searchParams.get('db')
    const dbFromPath = parsed.pathname.slice(1)
    const dbRaw = dbFromQuery || dbFromPath
    if (dbRaw) {
      const db = parseInt(dbRaw, 10)
      if (!Number.isNaN(db)) opts.db = db
    }

    return opts
  } catch {
    return undefined
  }
}

export async function createDefaultEvolutionQueue(): Promise<EvolutionQueue> {
  const redis = parseRedisUrl(process.env.REDIS_URL)
  if (!redis) {
    return new InMemoryEvolutionQueue()
  }

  // Probe Redis before committing to BullMQ so a misconfigured/broken Redis
  // does not prevent the app from starting in environments where fallback is acceptable.
  let probe: Redis | undefined
  try {
    probe = new Redis({ ...(redis as RedisOptions), lazyConnect: true, connectTimeout: 2000, maxRetriesPerRequest: 0 })
    probe.on('error', () => {
      // Suppress probe errors; we only care whether ping succeeds.
    })
    await probe.connect()
    await probe.ping()
    console.log('[EVOLUTION] Redis is reachable, using BullMQ queue')
    return new BullMqEvolutionQueue('evolution', redis)
  } catch (err) {
    console.warn('[EVOLUTION] Redis unavailable, falling back to in-memory queue:', (err as Error).message)
    return new InMemoryEvolutionQueue()
  } finally {
    if (probe) {
      try {
        await probe.disconnect()
      } catch {
        // Ignore disconnect errors.
      }
    }
  }
}
