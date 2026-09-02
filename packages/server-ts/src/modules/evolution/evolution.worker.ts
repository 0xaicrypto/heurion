import { Worker, type ConnectionOptions } from 'bullmq'
import { getUserContext } from '../chat/user-context.js'
import { ChatIngester } from '../memorization/chat-ingester.service.js'
import { extractTakeaways } from '../practitioner/session-takeaway.service.js'
import { MemoryGraphGateway } from '../../memory/memory-gateway.js'
import type { EvolutionJob, EvolutionJobProcessor } from './evolution.queue.js'
import { makeLogger } from '../../common/logger.js'

const log = makeLogger('evolution')

export interface EvolutionWorkerOptions {
  concurrency: number
  lockDuration: number
}

function loadWorkerOptions(): EvolutionWorkerOptions {
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
        // #680: the extracted entities previously went nowhere — route them
        // through the same propose → review-queue pipeline as chat-ingester
        // (dedup + approval side effect), instead of burning the LLM call.
        const gateway = new MemoryGraphGateway(userId, ctx.memory)
        const ingester = new ChatIngester(ctx.memory.eventLog, gateway)
        await ingester.ingestEncounter({
          userId,
          patientHash,
          encounterId: sessionId,
          sourceText: conversation,
        }).catch(() => {})
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
    log.info(`[EVOLUTION] Completed job ${job.id} for user ${(job.data as EvolutionJob).userId}`)
  })
  worker.on('failed', (job, err) => {
    log.error(`[EVOLUTION] Failed job ${job?.id} (attempt ${job?.attemptsMade ?? 0}):`, err.message)
  })

  return worker
}
