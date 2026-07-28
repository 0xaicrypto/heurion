import { Worker } from 'bullmq'
import { createApp } from './app'
import { config } from './config'
import { createDefaultEvolutionQueue, BullMqEvolutionQueue, type EvolutionQueue } from './modules/evolution/evolution.queue.js'
import { startEvolutionWorker } from './modules/evolution/evolution.worker.js'
import { createGapResearchScheduler, type GapResearchScheduler } from './modules/knowledge/gap-research.service.js'

async function main() {
  const evolutionQueue = await createDefaultEvolutionQueue()
  const app = await createApp({ evolutionQueue })
  await app.listen({ port: config.port, host: config.host })
  console.log(`Heurion TS backend listening on ${config.host}:${config.port}`)

  // Start the background evolution worker when running against Redis/BullMQ.
  let worker: Worker | undefined
  const workerEnabled = process.env.EVOLUTION_WORKER_ENABLED !== 'false'
  if (workerEnabled && evolutionQueue instanceof BullMqEvolutionQueue) {
    worker = startEvolutionWorker(evolutionQueue.name, evolutionQueue.connection)
    console.log('[EVOLUTION] BullMQ worker started')
  }

  // Start the autonomous gap-research scheduler (periodic web search for open gaps).
  let gapResearchScheduler: GapResearchScheduler | undefined
  const gapResearchEnabled = process.env.GAP_RESEARCH_ENABLED !== 'false'
  if (gapResearchEnabled) {
    const intervalMs = parseInt(process.env.GAP_RESEARCH_INTERVAL_MS || '300000', 10)
    gapResearchScheduler = createGapResearchScheduler(intervalMs, {
      maxPerRun: parseInt(process.env.GAP_RESEARCH_MAX_PER_RUN || '5', 10),
      minAgeMs: parseInt(process.env.GAP_RESEARCH_MIN_AGE_MS || '60000', 10),
    })
    gapResearchScheduler.start()
    console.log(`[GAP-RESEARCH] Scheduler started (interval ${intervalMs}ms)`)
  }

  // Graceful shutdown: stop accepting new jobs, finish in-flight work, then exit.
  let shuttingDown = false
  async function shutdown(signal: string) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[SHUTDOWN] Received ${signal}, closing worker/queue/server...`)

    try {
      if (worker) {
        await worker.close()
        console.log('[SHUTDOWN] Worker closed')
      }
    } catch (err) {
      console.error('[SHUTDOWN] Worker close error:', err)
    }

    try {
      gapResearchScheduler?.stop()
      console.log('[SHUTDOWN] Gap research scheduler stopped')
    } catch (err) {
      console.error('[SHUTDOWN] Gap research scheduler stop error:', err)
    }

    try {
      await evolutionQueue.close()
      console.log('[SHUTDOWN] Queue closed')
    } catch (err) {
      console.error('[SHUTDOWN] Queue close error:', err)
    }

    try {
      await app.close()
      console.log('[SHUTDOWN] Server closed')
    } catch (err) {
      console.error('[SHUTDOWN] Server close error:', err)
    }

    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
