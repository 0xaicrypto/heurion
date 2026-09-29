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
import { getUserContext } from '../shared/user-context'
import { MemoryGraphGateway } from '../../memory/memory-gateway.js'
import prisma from '../../common/prisma'
import { createDefaultWebSearchProvider, type WebSearchProvider } from './web-search.service'
import { PrismaTelemetryService } from './telemetry.service'
import { makeLogger } from '../../common/logger.js'
import { acquireSchedulerLease } from '../../common/scheduler-lease.js'

const log = makeLogger('knowledge.gap-research')

const telemetry = new PrismaTelemetryService()

export interface GapResearchOptions {
  /** Maximum number of open gaps to research per scheduler tick. */
  maxPerRun?: number
  /** Minimum age (ms) before a gap is eligible for auto-research. */
  minAgeMs?: number
  /** Optional custom search provider; defaults to PubMed + placeholder. */
  provider?: WebSearchProvider
  /** #1150-followup: 残留 researching 的回收时限(默认 30 分钟)。 */
  staleResearchMs?: number
}

/** 默认判定"残留 researching"的时限(超过视为进程中断遗留)。 */
export const DEFAULT_GAP_STALE_MS = 30 * 60 * 1000

/**
 * #1150-followup — 回收残留 researching:研究中途进程被杀(部署/崩溃)时,
 * gap 会永久停在 researching(claim 后无人放回),再也不会被研究。
 * 启动与每次 tick 前调用(单实例内 running 标志保证不会误伤在飞研究)。
 */
export async function resetStaleResearchingGaps(staleMs: number = DEFAULT_GAP_STALE_MS): Promise<number> {
  const cutoff = new Date(Date.now() - Math.max(0, staleMs)).toISOString()
  try {
    const res = await prisma.knowledgeGap.updateMany({
      where: { status: 'researching', lastAttemptAt: { lt: cutoff } },
      data: { status: 'open' },
    })
    if (res.count > 0) log.warn(`[GAP-RESEARCH] recovered ${res.count} stale researching gap(s) → open`)
    return res.count
  } catch (err) {
    log.warn('stale researching cleanup failed', { reason: (err as Error).message?.slice(0, 120) })
    return 0
  }
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

    const rows: any[] = await prisma.knowledgeGap.findMany({
      where: {
        status: 'open',
        createdAt: { lte: cutoff },
      },
      // #1143: 先试过且无结果的 gap 退到队尾(lastAttemptAt 升序,从未尝试
      // 的 NULL 优先)— 旧实现按 createdAt 固定取最老 5 条,无文献的旧 gap
      // 永久占位,新 gap 永远轮不到。
      orderBy: [{ lastAttemptAt: 'asc' }, { createdAt: 'asc' }],
      take: maxPerRun,
    })

    const errors: string[] = []
    let processed = 0

    for (const row of rows) {
      // #1143: 原子认领 open→researching(带 lastAttemptAt/attempts 记录) —
      // 防慢 tick 下同一 gap 被并发研究两次产生重复提案。
      const claim = await prisma.knowledgeGap.updateMany({
        where: { id: row.id, status: 'open' },
        data: { status: 'researching', lastAttemptAt: new Date().toISOString(), attempts: { increment: 1 } },
      })
      if (claim.count === 0) continue // 已被其他 tick/实例认领

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
        // #1143: 研究失败必须放回 open(否则该 gap 永久停在 researching 再
        // 也不被扫描);lastAttemptAt 已推进,下轮自然让位给其他 gap。
        await prisma.knowledgeGap.updateMany({
          where: { id: gap.id, status: 'researching' },
          data: { status: 'open', updatedAt: new Date().toISOString() },
        }).catch(() => { /* best-effort */ })
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
      // #1143: 认领后无结果必须放回 open(保留重试),lastAttemptAt 已推进
      // → 下轮退到其他 gap 之后,不再队首阻塞。
      await prisma.knowledgeGap.updateMany({
        where: { id: gap.id, status: 'researching' },
        data: { status: 'open', updatedAt: new Date().toISOString() },
      }).catch(() => { /* best-effort */ })
      return
    }

    const ctx = getUserContext(gap.userId)
    // #839: 机器自动研究产物不再直写图谱 — 改走写入闸门(pending 人工审),
    // 语义去重/冲突标记/审计链全部生效。图谱 gap 关联延迟到审批通过时
    // (approval.service 识别 `gap:` sourceRange 补挂 answerGap)。
    // Prisma 侧 gap 仍即刻 resolve:调度器按 status:'open' 扫描,不 resolve
    // 会导致同一 gap 每 tick 重复研究、重复提案。
    const gateway = new MemoryGraphGateway(gap.userId, ctx.memory)
    const proposal = await gateway.propose({
      scopeType: 'global',
      kind: 'fact',
      content: searchResult.text,
      importance: 4,
      confidence: 'medium',
      reason: `自动研究命中(${this.provider.name})：${gap.content.slice(0, 60)}`,
      sourceRange: `gap:${gap.id}`,
      category: 'fact',
    })

    const updated = await this.gapService.resolve(gap.id, searchResult.text)
    if (!updated) {
      throw new Error('gap disappeared during research')
    }

    await telemetry.record({
      userId: gap.userId,
      workspaceId: gap.workspaceId,
      category: 'gap',
      action: 'auto_resolved',
      metadata: { gapId: gap.id, proposalId: proposal.id, source: this.provider.name },
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
  // #1143: 防重入 — 慢 tick(外部检索/LLM 超过 interval)时上一次未结束,
  // 旧实现直接再起一轮,同一批 gap 被并发研究产生重复提案。
  let running = false

  return {
    start() {
      if (timer) return
      timer = setInterval(() => {
        if (running) {
          log.warn('[GAP-RESEARCH] tick skipped — previous run still in progress')
          return
        }
        running = true
        void (async () => {
          try {
            // #1154: DB 租约 — 多实例/滚动发布期间同名调度器只有一个持有者。
            if (!(await acquireSchedulerLease('gap-research', intervalMs))) {
              log.info('[GAP-RESEARCH] tick skipped — lease held elsewhere')
              return
            }
            // #1150-followup: 先回收上次进程中断遗留的 researching。
            await resetStaleResearchingGaps(options?.staleResearchMs)
            const result = await service.researchOpenGaps(options)
            if (result.processed > 0 || result.errors.length > 0) {
              log.info('[GAP-RESEARCH] processed', result.processed, 'errors', result.errors.length)
            }
          } catch (err) {
            log.error('[GAP-RESEARCH] scheduler tick failed:', err)
          } finally {
            // 租约未拿到/异常路径同样释放 running，避免调度器此后永久空转。
            running = false
          }
        })()
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
