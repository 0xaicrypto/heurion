import { Worker, type ConnectionOptions } from 'bullmq'
import { getUserContext } from '../chat/user-context.js'
import type { EvolutionJob, EvolutionJobProcessor } from './evolution.queue.js'

export interface EvolutionWorkerOptions {
  concurrency: number
  lockDuration: number
}

export function loadWorkerOptions(): EvolutionWorkerOptions {
  return {
    concurrency: parseInt(process.env.EVOLUTION_WORKER_CONCURRENCY || '3', 10),
    lockDuration: parseInt(process.env.EVOLUTION_WORKER_LOCK_DURATION || '30000', 10),
  }
}

export const processEvolutionTurn: EvolutionJobProcessor = async (job) => {
  const ctx = getUserContext(job.userId)
  await ctx.orchestrator.postTurn(job.userId, job.sessionId, job.userMessage, job.patientHash)
}

export function startEvolutionWorker(
  queueName: string,
  connection: ConnectionOptions,
  processor: EvolutionJobProcessor = processEvolutionTurn,
  opts: EvolutionWorkerOptions = loadWorkerOptions(),
): Worker {
  const worker = new Worker(
    queueName,
    async (job) => {
      await processor(job.data as EvolutionJob)
    },
    { connection, concurrency: opts.concurrency, lockDuration: opts.lockDuration },
  )

  worker.on('completed', (job) => {
    console.log(`[EVOLUTION] Completed job ${job.id} for user ${(job.data as EvolutionJob).userId}`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[EVOLUTION] Failed job ${job?.id} (attempt ${job?.attemptsMade ?? 0}):`, err.message)
  })

  return worker
}
