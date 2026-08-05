import prisma from '../common/prisma.js'
import type { MemoryService } from './memory.service.js'
import type { EpisodesStore } from '../evolution/stores'

/**
 * K3/K4 — session summaries and knowledge-article synthesis driven by NEW
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
        model: process.env.DEEPSEEK_CHAT_MODEL || 'deepseek-v4-flash',
        maxTokens: 400,
        telemetryContext: { userId: input.userId, workspaceId: input.userId, action: 'memory.episode_summary' },
      },
    )
    if (!summary.trim()) return previous || ''
    input.episodes.upsert(input.sessionId, summary, input.turnCount)
    input.episodes.commit()
    return summary
  } catch (err) {
    console.log('[SUMMARY] Episode update skipped:', (err as Error).message.slice(0, 120))
    return previous || ''
  }
}

/**
 * K4 — synthesize a knowledge article when a scope has >= 3 NEW confirmed
 * facts of the same category not yet used by any article. Input facts are
 * ranked by importance and capped at 10. The article proposal goes to the
 * pending review queue.
 */
export async function maybeSynthesizeArticle(
  userId: string,
  scope: { patientHash?: string; studyId?: string },
  memory: MemoryService,
): Promise<void> {
  try {
    const nodes = memory.graph.getCurrentNodesByType('fact') as any[]
    const scoped = nodes.filter((n) =>
      n.type === 'fact' &&
      (scope.patientHash ? n.patientHash === scope.patientHash : true) &&
      (scope.studyId ? n.studyId === scope.studyId : true),
    )
    if (scoped.length < 3) return

    // "Used" = stableId appears in any current article's sourceFacts.
    const articles = memory.graph.getCurrentNodesByType('article') as any[]
    const usedStableIds = new Set<string>()
    for (const a of articles) {
      for (const sf of a.sourceFacts || []) usedStableIds.add(sf.stableId)
    }
    const unused = scoped.filter((f) => !usedStableIds.has(f.stableId))
    if (unused.length < 3) return

    const byCategory = new Map<string, any[]>()
    for (const f of unused) {
      const cat = f.category || 'fact'
      if (!byCategory.has(cat)) byCategory.set(cat, [])
      byCategory.get(cat)!.push(f)
    }
    const best = [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length)[0]
    if (!best || best[1].length < 3) return

    // §13.3C: at least 3 candidates must have been confirmed within the last
    // 7 days — historical facts alone must not trigger a synthesis (noise).
    const sevenDaysAgo = Date.now() - 7 * 86400_000
    const recent = best[1].filter((f) => (f.createdAt || 0) >= sevenDaysAgo)
    if (recent.length < 3) return

    const articleFacts = recent
      .sort((a, b) => (b.importance ?? 3) - (a.importance ?? 3))
      .slice(0, 10)

    const { deepseekChat, getApiKey } = await import('../common/llm.js')
    const apiKey = getApiKey()
    const factList = articleFacts
      .map((f) => `[importance=${f.importance ?? 3}] [${f.sourceType || 'general'}] ${f.content}`)
      .join('\n')
    const prompt = `你是临床知识合成器。基于以下已确认的事实合成一篇简短知识文章（1-2 段，临床可执行）：
\n${factList}\n\n返回 ONLY JSON: {"title": "...", "content": "..."}`

    const result = await deepseekChat(
      [{ role: 'user', content: prompt }],
      apiKey,
      {
        model: process.env.DEEPSEEK_CHAT_MODEL || 'deepseek-v4-flash',
        maxTokens: 512,
        telemetryContext: { userId, workspaceId: userId, action: 'memory.article_synthesis' },
      },
    )
    const jsonMatch = result.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return
    const article = JSON.parse(jsonMatch[0])
    if (!article.title || !article.content) return

    const { MemoryGraphGateway } = await import('./memory-gateway.js')
    const gateway = new MemoryGraphGateway(userId, memory, null as any, null as any, null as any, null as any)
    await gateway.propose({
      scopeType: scope.patientHash ? 'patient' : scope.studyId ? 'study' : 'global',
      patientHash: scope.patientHash,
      studyId: scope.studyId,
      kind: 'article',
      content: `${article.title}\n\n${article.content}`,
      importance: 3,
      confidence: 'medium',
      reason: `AI synthesis from ${articleFacts.length} confirmed ${best[0]} facts`,
    })
    console.log(`[KNOWLEDGE] Article proposed: ${article.title}`)
  } catch (err) {
    console.log('[KNOWLEDGE] Article synthesis skipped:', (err as Error).message.slice(0, 120))
  }
}
