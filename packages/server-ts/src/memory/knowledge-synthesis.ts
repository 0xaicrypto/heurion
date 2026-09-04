import { resolveTierModel } from '../common/llm-gateway.js'
import type { MemoryService } from './memory.service.js'
import type { EpisodesStore } from '../evolution/stores'
import { makeLogger } from '../common/logger.js'

const log = makeLogger('documents.summary')

/**
 * K3/K4 — session summaries and knowledge-summary synthesis driven by NEW
 * confirmed facts (BRAIN2_MEMORY_LIFECYCLE §5.3–5.4, issue #110).
 */

export interface EpisodeSummaryInput {
  userId: string
  sessionId: string
  patientHash?: string
  episodes: EpisodesStore
  incrementalText: string
  turnCount: number
}

/**
 * K3 — incremental LLM episode summary. With a previous summary, the prompt
 * asks for an update (preserve still-true details, merge new facts) instead
 * of a rebuild. On failure the old summary is kept.
 */
export async function updateEpisodeSummary(input: EpisodeSummaryInput): Promise<string> {
  const { deepseekChat, getApiKey } = await import('../common/llm.js')
  const apiKey = getApiKey()

  const existing = input.episodes.all().find((e) => e.sessionId === input.sessionId)
  const previous = existing?.summary

  const prompt = previous
    ? `更新下面的会话摘要：用对话增量合并新信息，保留仍然成立的旧细节，移除已过时的细节。\n<previous-summary>\n${previous}\n</previous-summary>\n\n对话增量：\n${input.incrementalText.slice(0, 6000)}\n\n输出更新后的摘要（中文，≤300 tokens，要点式）。`
    : `为以下临床对话生成会话摘要（中文，≤300 tokens，要点式，保留患者标识/诊断/决策/待办）：\n\n${input.incrementalText.slice(0, 6000)}`

  try {
    const summary = await deepseekChat(
      [{ role: 'user', content: prompt }],
      apiKey,
      {
        model: resolveTierModel('fast'),
        maxTokens: 400,
        telemetryContext: { userId: input.userId, workspaceId: input.userId, action: 'memory.episode_summary' },
      },
    )
    if (!summary.trim()) return previous || ''
    input.episodes.upsert(input.sessionId, summary, input.turnCount)
    input.episodes.commit()
    return summary
  } catch (err) {
    log.info('[SUMMARY] Episode update skipped:', (err as Error).message.slice(0, 120))
    return previous || ''
  }
}

/**
 * K4 — knowledge-summary synthesis. #816: 触发改为覆盖率驱动 — 按类目
 * 聚合"未被任何 summary 覆盖(且未被 pending 提案占用)"的 facts,最大簇
 * ≥3 即合成,替代原先的"近 7 天确认 ≥3"硬编码时间条件(长尾主题从此
 * 有覆盖路径);时间窗保留为 coverage 数据不可用时的兜底。
 *
 * 缺陷修复(#816 顺带):
 * ① 全局 scope 患者隔离 — 空 scope 只聚合无 patientHash/studyId 的
 *    facts;此前两个过滤条件退化为 true,跨患者碎片会混入"全局"总结。
 * ② "used" 判定纳入 pending — pending 的 summary 提案已通过 relatedFacts
 *    占用其源 facts;此前只统计 current summary,同一批 facts 在审批前
 *    可被重复触发合成。
 * ③ "确认时间"语义:提案制下 fact 在审批通过时才经 defaultProposalApplier
 *    写入 graph(addFact),createdAt 即确认时间;直写路径(chat 提取)
 *    createdAt 即提取确认时间。故沿用 createdAt 是准确近似,不新增
 *    confirmedAt 字段 — 此注释即为该决策的显式记录。
 */
export async function maybeSynthesizeSummary(
  userId: string,
  scope: { patientHash?: string; studyId?: string },
  memory: MemoryService,
): Promise<void> {
  try {
    const nodes = memory.graph.getCurrentNodesByType('fact') as any[]
    // ① 患者隔离:三分支互斥,空 scope 严格收窄到全局 facts。
    const scoped = nodes.filter((n) =>
      n.type === 'fact' &&
      (scope.patientHash
        ? n.patientHash === scope.patientHash
        : scope.studyId
          ? n.studyId === scope.studyId
          : !n.patientHash && !n.studyId),
    )
    if (scoped.length < 3) return

    // ② "Used" = current summary 的 sourceFacts ∪ pending summary 提案占用。
    const summaries = memory.graph.getCurrentNodesByType('summary') as any[]
    const usedStableIds = new Set<string>()
    for (const a of summaries) {
      for (const sf of a.sourceFacts || []) usedStableIds.add(sf.stableId)
    }
    const { getPendingOccupiedFactIds } = await import('./coverage.js')
    for (const id of await getPendingOccupiedFactIds(userId, scope)) usedStableIds.add(id)
    const unused = scoped.filter((f) => !usedStableIds.has(f.stableId))
    if (unused.length < 3) return

    // #816: 覆盖率驱动 — 按类目聚合未覆盖 facts,最大簇胜出(≥3)。
    // 7 天硬门槛移除:长尾陈旧 facts 正是覆盖率要补的对象;原门槛防的
    // 噪声(同批 facts 反复触发)已由 ② pending 占用根治。7 天窗降级为
    // 可观测信号(新鲜度画像入日志,不阻塞调度)。
    const byCategory = new Map<string, any[]>()
    for (const f of unused) {
      const cat = f.category || 'fact'
      if (!byCategory.has(cat)) byCategory.set(cat, [])
      byCategory.get(cat)!.push(f)
    }
    const best = [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length)[0]
    if (!best || best[1].length < 3) return

    const sevenDaysAgo = Date.now() - 7 * 86400_000
    const recentCount = best[1].filter((f) => (f.createdAt || 0) >= sevenDaysAgo).length
    log.info('[KNOWLEDGE] Coverage-driven synthesis candidate', {
      category: best[0],
      clusterSize: best[1].length,
      recentConfirmations: recentCount,
      patientIsolated: !!scope.patientHash || !!scope.studyId,
    })

    const summaryFacts = best[1]
      .sort((a, b) => (b.importance ?? 3) - (a.importance ?? 3))
      .slice(0, 10)

    const { deepseekChat, getApiKey } = await import('../common/llm.js')
    const { parseLlmJson } = await import('../common/llm-json.js')
    const { summarySynthesisPrompt } = await import('./prompts.js')
    const { normalizeSynthesizedSummary } = await import('./summary-contract.js')
    const apiKey = getApiKey()
    // #813: 每行前置 fact stableId — 合成模型按 ID 回指,归一化层过滤编造 ID。
    const factList = summaryFacts
      .map((f) => `[${f.stableId}] importance=${f.importance ?? 3} source=${f.sourceType || 'general'}: ${f.content}`)
      .join('\n')
    const prompt = summarySynthesisPrompt(factList)

    const result = await deepseekChat(
      [{ role: 'user', content: prompt }],
      apiKey,
      {
        model: resolveTierModel('fast'),
        maxTokens: 900,
        telemetryContext: { userId, workspaceId: userId, action: 'memory.summary_synthesis' },
      },
    )
    const parsed = parseLlmJson<unknown>(result)
    // #813: answer-ready 契约归一化(结论/依据/caveat + factId 白名单过滤);
    // 结构不可用时返回 null,本轮不提案(宁缺毋滥,不让摘要体总结静默通过)。
    const normalized = normalizeSynthesizedSummary(parsed, summaryFacts.map(f => f.stableId))
    if (!normalized) {
      log.info('[KNOWLEDGE] Summary synthesis skipped: unparseable contract')
      return
    }

    const { MemoryGraphGateway } = await import('./memory-gateway.js')
    const gateway = new MemoryGraphGateway(userId, memory)
    await gateway.propose({
      scopeType: scope.patientHash ? 'patient' : scope.studyId ? 'study' : 'global',
      patientHash: scope.patientHash,
      studyId: scope.studyId,
      kind: 'summary',
      content: normalized.content,
      importance: 3,
      confidence: 'medium',
      reason: `AI synthesis from ${summaryFacts.length} confirmed ${best[0]} facts`,
      // #736/#748: provenance — on approval the summary binds these so the
      // "used" set excludes them from future synthesis rounds.
      relatedFacts: summaryFacts.map(f => f.stableId),
    })
    log.info(`[KNOWLEDGE] Summary proposed: ${normalized.title}`)
  } catch (err) {
    log.info('[KNOWLEDGE] Summary synthesis skipped:', (err as Error).message.slice(0, 120))
  }
}
