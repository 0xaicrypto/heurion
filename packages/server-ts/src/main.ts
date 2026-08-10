import { Worker } from 'bullmq'
import { createApp } from './app'
import { config } from './config'
import { execSync } from 'child_process'
import { enableSqliteWal } from './common/prisma.js'
import { createDefaultEvolutionQueue, BullMqEvolutionQueue, type EvolutionQueue } from './modules/evolution/evolution.queue.js'
import { startEvolutionWorker } from './modules/evolution/evolution.worker.js'
import { createGapResearchScheduler, type GapResearchScheduler } from './modules/knowledge/gap-research.service.js'
import { createExperienceSynthesisScheduler } from './modules/skills/experience-synthesis.service.js'

async function main() {
  // Run Prisma schema migration at startup
  try {
    execSync('npx prisma db push --accept-data-loss --skip-generate', {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
    })
    // Generate Prisma client (needed after push)
    execSync('npx prisma generate', {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
    })
    console.log('[DB] Schema synced')
  } catch (err) {
    console.warn('[DB] Schema sync failed (non-fatal):', (err as Error)?.message || err)
  }

  const evolutionQueue = await createDefaultEvolutionQueue()
  // SQLite WAL (idempotent) — concurrent reads never block writes.
  await enableSqliteWal().catch(() => {})
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

  // #24: periodic experience synthesis (multiple cases → skill candidates).
  let experienceScheduler: ReturnType<typeof createExperienceSynthesisScheduler> | undefined
  const experienceSynthesisEnabled = process.env.EXPERIENCE_SYNTHESIS_ENABLED !== 'false'
  if (experienceSynthesisEnabled) {
    const intervalMs = parseInt(process.env.EXPERIENCE_SYNTHESIS_INTERVAL_MS || (24 * 3600 * 1000).toString(), 10)
    experienceScheduler = createExperienceSynthesisScheduler(intervalMs, {
      minFacts: parseInt(process.env.EXPERIENCE_SYNTHESIS_MIN_FACTS || '3', 10),
      maxCandidates: parseInt(process.env.EXPERIENCE_SYNTHESIS_MAX_CANDIDATES || '3', 10),
    })
    experienceScheduler.start()
    console.log(`[EXPERIENCE-SYNTHESIS] Scheduler started (interval ${intervalMs}ms)`)
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
      experienceScheduler?.stop()
      console.log('[SHUTDOWN] Experience synthesis scheduler stopped')
    } catch (err) {
      console.error('[SHUTDOWN] Experience synthesis scheduler stop error:', err)
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
