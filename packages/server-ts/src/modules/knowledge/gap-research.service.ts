/**
 * Autonomous gap research scheduler.
 *
 * Periodically scans open knowledge gaps, runs a web search for each, and
 * writes the result back as a fact that answers the gap. This lets the
 * system close gaps without manual user input when authoritative sources
 * are available.
 */

import type { KnowledgeGap } from './knowledge-gap.service'
import { PrismaKnowledgeGapService } from './knowledge-gap.service'
import { getUserContext } from '../chat/user-context'
import prisma from '../../common/prisma'
import { createDefaultWebSearchProvider, type WebSearchProvider } from './web-search.service'
import { PrismaTelemetryService } from './telemetry.service'

const telemetry = new PrismaTelemetryService()

export interface GapResearchOptions {
  /** Maximum number of open gaps to research per scheduler tick. */
  maxPerRun?: number
  /** Minimum age (ms) before a gap is eligible for auto-research. */
  minAgeMs?: number
  /** Optional custom search provider; defaults to PubMed + placeholder. */
  provider?: WebSearchProvider
}

export class GapResearchService {
  private gapService = new PrismaKnowledgeGapService()
  private provider: WebSearchProvider

  constructor(provider?: WebSearchProvider) {
    this.provider = provider || createDefaultWebSearchProvider()
  }

  async researchOpenGaps(options: GapResearchOptions = {}): Promise<{ processed: number; errors: string[] }> {
    const maxPerRun = options.maxPerRun ?? 5
    const minAgeMs = options.minAgeMs ?? 60_000
    const cutoff = new Date(Date.now() - minAgeMs).toISOString()

    const rows: any[] = await (prisma as any).knowledgeGap.findMany({
      where: {
        status: 'open',
        createdAt: { lte: cutoff },
      },
      orderBy: { createdAt: 'asc' },
      take: maxPerRun,
    })

    const errors: string[] = []
    let processed = 0

    for (const row of rows) {
      const gap: KnowledgeGap = {
        id: row.id,
        userId: row.userId,
        workspaceId: row.workspaceId,
        content: row.content,
        source: row.source,
        sourceId: row.sourceId ?? undefined,
        status: row.status,
        answerId: row.answerId ?? undefined,
        answerText: row.answerText ?? undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }

      try {
        await this.researchGap(gap)
        processed++
      } catch (err) {
        errors.push(`${gap.id}: ${(err as Error).message}`)
      }
    }

    return { processed, errors }
  }

  private async researchGap(gap: KnowledgeGap): Promise<void> {
    const searchResult = await this.provider.search(gap.content)

    // #254: "no results" is temporary and search-dependent — persisting it
    // as a fact pollutes the memory graph and makes the AI conclude "no
    // literature supports this". Leave the gap open for a later retry.
    if (!searchResult.found) {
      await telemetry.record({
        userId: gap.userId,
        workspaceId: gap.workspaceId,
        category: 'gap',
        action: 'auto_skipped_no_results',
        metadata: { gapId: gap.id, reason: searchResult.text.slice(0, 120) },
      }).catch(() => {})
      return
    }

    const ctx = getUserContext(gap.userId)
    const fact = ctx.memory.addFact(
      {
        content: searchResult.text,
        category: 'fact',
        importance: 4,
        sourceType: 'research',
      },
      'system',
    )

    // Best-effort link to any memory gap node.
    try {
      ctx.memory.answerGap(gap.id, fact)
    } catch {
      // Gap may only exist in Prisma; continue to resolve via the service.
    }

    const updated = await this.gapService.resolve(gap.id, searchResult.text)
    if (!updated) {
      throw new Error('gap disappeared during research')
    }

    await telemetry.record({
      userId: gap.userId,
      workspaceId: gap.workspaceId,
      category: 'gap',
      action: 'auto_resolved',
      metadata: { gapId: gap.id, factId: fact.stableId, source: this.provider.name },
    }).catch(() => {})
  }
}

export interface GapResearchScheduler {
  start(): void
  stop(): void
}

export function createGapResearchScheduler(
  intervalMs: number,
  options?: GapResearchOptions,
): GapResearchScheduler {
  const service = new GapResearchService(options?.provider)
  let timer: ReturnType<typeof setInterval> | null = null

  return {
    start() {
      if (timer) return
      timer = setInterval(async () => {
        try {
          const result = await service.researchOpenGaps(options)
          if (result.processed > 0 || result.errors.length > 0) {
            console.log('[GAP-RESEARCH] processed', result.processed, 'errors', result.errors.length)
          }
        } catch (err) {
          console.error('[GAP-RESEARCH] scheduler tick failed:', err)
        }
      }, intervalMs)
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
