import { Worker, type ConnectionOptions } from 'bullmq'
import { getUserContext } from '../chat/user-context.js'
import { extractClinicalEntities } from '../memorization/clinical-extractor.service.js'
import { extractTakeaways } from '../practitioner/session-takeaway.service.js'
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
  const { userId, sessionId, userMessage, patientHash } = job

  await ctx.orchestrator.postTurn(userId, sessionId, userMessage, patientHash)

  if (patientHash && userMessage.length > 50) {
    try {
      const recentEvents = ctx.memory.eventLog.query({ sessionId, limit: 6 }).reverse()
      const conversation = recentEvents
        .map(e => `${e.eventType === 'user_message' ? 'USER' : 'AI'}: ${e.content.slice(0, 500)}`)
        .join('\n')

      if (conversation.length > 100) {
        extractClinicalEntities(conversation, { maxTokens: 3000 }).catch(() => {})
      }
    } catch {}
  }

  try {
    const sessionEvents = ctx.memory.eventLog.query({ sessionId })
    // Count only user messages as turns — tool_call/tool_result events
    // (R3) would otherwise inflate sessionEvents.length / 2.
    const turnCount = sessionEvents.filter((e) => e.eventType === 'user_message').length
    if (turnCount > 0 && turnCount % 5 === 0) {
      const recentEvents = ctx.memory.eventLog.query({ sessionId, limit: 10 }).reverse()
      const conversation = recentEvents
        .map(e => `${e.eventType === 'user_message' ? 'USER' : 'AI'}: ${e.content.slice(0, 500)}`)
        .join('\n')
      if (conversation.length > 200) {
        extractTakeaways({
          userId,
          sessionId,
          conversationText: conversation,
          patientHash,
        }).catch(() => {})
      }
    }
  } catch {}
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
