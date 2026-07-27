import { Worker } from 'bullmq'
import { createApp } from './app'
import { config } from './config'
import { createDefaultEvolutionQueue, BullMqEvolutionQueue, type EvolutionQueue } from './modules/evolution/evolution.queue.js'
import { startEvolutionWorker } from './modules/evolution/evolution.worker.js'

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
