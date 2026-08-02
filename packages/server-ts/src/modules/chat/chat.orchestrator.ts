import { EventLog, Event } from '../../core/event-log'
import { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../../evolution/stores'
import { ContractEngine } from '../../core/contracts'
import { MemoryProjection } from '../../retrieval/memory-projection'
import { deepseekChat, getApiKey } from '../../common/llm.js'
import { router, RouterResult } from '../../retrieval/query-router'

function extractKeywords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(w => w.length > 3)
}

function matchesKeywords(text: string, keywords: string[]): boolean {
  if (keywords.length === 0 || !text) return false
  const t = text.toLowerCase()
  return keywords.some(k => t.includes(k))
}

function daysAgo(timestamp?: number): number {
  if (!timestamp) return 999
  return (Date.now() / 1000 - timestamp) / 86400
}

function filterFacts(facts: any[], query: string, patientHash?: string): any[] {
  if (facts.length <= 20) return facts
  const keywords = extractKeywords(query)
  const scored = facts.map(f => {
    let score = 0
    if ((f.importance || 3) >= 4) score += 100
    if (patientHash && f.patientHash === patientHash) score += 80
    if (matchesKeywords(f.content, keywords)) score += 60
    score += Math.max(0, 30 - daysAgo(f.lastSeenAt || f.createdAt) * 3)
    return { f, score }
  })
  const baseline = scored.filter(s => s.score >= 80).map(s => s.f)
  const rest = scored
    .filter(s => s.score < 80)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, 30 - baseline.length))
    .map(s => s.f)
  return [...baseline, ...rest]
}

function filterKnowledge(articles: any[], query: string): any[] {
  if (articles.length <= 10) return articles
  const keywords = extractKeywords(query)
  const scored = articles.map(a => {
    let score = 0
    const text = `${a.title || ''} ${a.content || ''}`
    if (matchesKeywords(text, keywords)) score += 80
    if (a.status === 'stale') score -= 20
    score += Math.max(0, 20 - daysAgo(a.updatedAt || a.createdAt))
    return { a, score }
  })
  return scored
    .filter(s => s.score > 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)
    .map(s => s.a)
}

function filterSkills(skills: any[], query: string): any[] {
  if (skills.length <= 10) return skills
  const keywords = extractKeywords(query)
  return skills
    .filter(s => matchesKeywords(`${s.name || ''} ${s.description || ''}`, keywords))
    .slice(0, 10)
}

function filterEpisodes(episodes: any[], query: string): any[] {
  if (episodes.length <= 5) return episodes
  const keywords = extractKeywords(query)
  const recent = episodes
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 5)
  const matched = episodes.filter(e => matchesKeywords(e.summary || '', keywords) && !recent.includes(e))
  return [...recent, ...matched].slice(0, 10)
}
import { handleKnowledgeCommand, CommandResult } from '../knowledge/knowledge-command-handler.js'
import { PrismaKnowledgeGapService } from '../knowledge/knowledge-gap.service.js'
import { type TelemetryService, NoopTelemetryService } from '../knowledge/telemetry.service.js'
import type { MemoryService } from '../../memory/memory.service.js'

export interface TurnResult {
  userEvent: Event
  response: string
  budget: any[]
  route?: RouterResult
  kbCommand?: boolean
}

// K2 debounce: one pending extraction per scope, merged within 2s.
const pendingExtractions = new Map<string, ReturnType<typeof setTimeout>>()

export class ChatOrchestrator {
  private projection: MemoryProjection
  private gapService = new PrismaKnowledgeGapService()

  /**
   * Route an AI-extracted fact into the pending review queue instead of
   * writing the memory graph directly (BRAIN2_MEMORY_LIFECYCLE §5.2).
   */
  async proposeFact(
    userId: string,
    patientHash: string | undefined,
    input: { category: string; importance: number; content: string; sourceType: string; patientHash?: string },
  ): Promise<void> {
    try {
      const { MemoryGraphGateway } = await import('../../memory/memory-gateway.js')
      const gateway = new MemoryGraphGateway(
        userId,
        this.memory!,
        this.factsStore,
        this.episodesStore,
        this.skillsStore,
        this.knowledgeStore,
      )
      await gateway.propose({
        scopeType: patientHash ? 'patient' : 'global',
        patientHash: input.patientHash || patientHash,
        kind: 'fact',
        content: input.content,
        importance: input.importance,
        confidence: 'medium',
        reason: `AI extraction (${input.category}, source: ${input.sourceType})`,
      })
    } catch (err) {
      console.log('[EVOLVE] Proposal write skipped:', (err as Error).message.slice(0, 120))
    }
  }  memory?: MemoryService

  constructor(
    private eventLog: EventLog,
    private factsStore: FactsStore,
    private episodesStore: EpisodesStore,
    private skillsStore: SkillsStore,
    private knowledgeStore: KnowledgeStore,
    private contracts: ContractEngine,
    private telemetry: TelemetryService = new NoopTelemetryService(),
  ) {
    this.projection = new MemoryProjection(eventLog)
  }

  async turn(params: {
    userId: string; message: string; sessionId: string
    patientHash: string | null; persona: string
    llmCall: (systemPrompt: string, userMessage: string) => Promise<string>
  }): Promise<TurnResult> {
    const { userId, message, sessionId, patientHash, persona, llmCall } = params

    const userEvent = this.eventLog.append({
      timestamp: Date.now() / 1000, eventType: 'user_message', content: message,
      metadata: { patientHash }, agentId: userId, sessionId,
    })

    const routeResult = await router(message)

    await this.telemetry.record({
      userId,
      workspaceId: userId,
      category: 'router',
      action: routeResult.intent,
      metadata: {
        ruleHit: routeResult.ruleHit,
        llmFallback: routeResult.llmFallback,
        llmCalls: routeResult.cost.llmCalls,
      },
    }).catch(() => {})

    // Knowledge commands are handled directly without calling the chat LLM
    if (routeResult.intent === 'knowledge_command') {
      return this.handleKnowledgeCommandTurn({ userId, message, sessionId, patientHash, userEvent, routeResult })
    }

    // For other intents, select context sources based on the route
    const context = this.buildProjectionContext({
      userId, message, patientHash, sessionId, persona, routeResult,
    })

    const projected = await this.projection.project(context)

    const preCheck = this.contracts.preCheck(message)
    if (preCheck.violations.length > 0) console.warn('pre-check violations:', preCheck.violations)

    const response = await llmCall(projected.systemPrompt, message)

    const postCheck = this.contracts.postCheck(message, response)
    this.eventLog.append({
      timestamp: Date.now() / 1000, eventType: 'assistant_response', content: response,
      metadata: { contractPassed: postCheck.passed }, agentId: userId, sessionId,
    })

    return { userEvent, response, budget: projected.budget, route: routeResult, kbCommand: false }
  }

  private buildProjectionContext(params: {
    userId: string
    message: string
    patientHash: string | null
    sessionId: string
    persona: string
    routeResult: RouterResult
  }) {
    const { userId, message, patientHash, sessionId, persona, routeResult } = params

    // Default: include all accumulated memory (mixed / fallback)
    let facts = this.factsStore.all()
    let episodes = this.episodesStore.all()
    let skills = this.skillsStore.all()

    if (routeResult.intent === 'sql') {
      // Factual patient queries: rely on patient context from SQL, skip accumulated memory
      facts = []
      episodes = []
      skills = []
    } else if (routeResult.intent === 'vector') {
      // Guideline / knowledge questions: skip episodic chat history, keep filtered facts
      facts = filterFacts(facts, message, patientHash || undefined)
      episodes = []
      skills = []
    } else if (routeResult.intent === 'file') {
      // File references are handled upstream; keep minimal context here
      facts = []
      episodes = []
      skills = []
    } else {
      // Mixed / fallback: keep high-signal memory but trim noise by query relevance
      facts = filterFacts(facts, message, patientHash || undefined)
      skills = filterSkills(skills, message)
      episodes = filterEpisodes(episodes, message)
    }

    return {
      userId,
      patientHash,
      sessionId,
      persona,
      facts,
      episodes,
      skills,
    }
  }

  private async handleKnowledgeCommandTurn(params: {
    userId: string
    message: string
    sessionId: string
    patientHash: string | null
    userEvent: Event
    routeResult: RouterResult
  }): Promise<TurnResult> {
    const { userId, message, sessionId, patientHash, userEvent, routeResult } = params

    const ctx = {
      workspaceId: userId,
      userId,
      factsStore: this.factsStore,
      knowledgeStore: this.knowledgeStore,
      gapService: this.gapService,
      memory: (this as any).memory,
    }

    const result = await handleKnowledgeCommand(ctx, message)
    const response = this.formatCommandResult(result)

    await this.telemetry.record({
      userId,
      workspaceId: userId,
      category: 'kb_command',
      action: result.type === 'error' ? 'error' : (result.type.replace(/^kb_/, '')),
      metadata: {
        commandType: result.type,
        hadError: result.type === 'error',
      },
    }).catch(() => {})

    this.eventLog.append({
      timestamp: Date.now() / 1000,
      eventType: 'assistant_response',
      content: response,
      metadata: { kbCommand: true, commandType: result.type },
      agentId: userId,
      sessionId,
    })

    return { userEvent, response, budget: [], route: routeResult, kbCommand: true }
  }

  private formatCommandResult(result: CommandResult): string {
    switch (result.type) {
      case 'kb_search_result':
        return result.summary
      case 'kb_remembered':
        return `✅ 已记录为 Fact #${result.factId}（置信度 ${Math.round(result.confidence * 100)}%）`
      case 'kb_pending_confirmation':
        return `⚠️ 请确认是否记录："${result.candidate}"（置信度 ${Math.round(result.confidence * 100)}%）`
      case 'kb_summary':
        return result.summary
      case 'kb_gaps':
        if (result.gaps.length === 0) return '当前没有未解问题。'
        return `未解问题（${result.gaps.length}）：\n` +
          result.gaps.map((g, i) => `${i + 1}. ${g.content}`).join('\n')
      case 'error':
        return `❌ ${result.message}`
      default:
        return '命令已处理。'
    }
  }

  // #2: Extract facts automatically using DeepSeek (K1/K2: incremental
  // cursor + event-driven trigger, debounced 2s per scope).
  async postTurn(userId: string, sessionId: string, userMessage: string, patientHash?: string) {
    const sessionEvents = this.eventLog.query({ sessionId })
    const turnCount = Math.floor(sessionEvents.length / 2)
    this.episodesStore.upsert(sessionId, userMessage.slice(0, 150), turnCount)

    await this.maybeScheduleIncrementalExtraction(userId, sessionId, patientHash)

    // Detect knowledge gaps on every turn — queries with no matching facts
    try {
      const factList = this.memory
        ? this.memory.graph.getCurrentNodesByType('fact').filter((n): n is import('../../memory/memory.types').FactNode => n.type === 'fact')
        : this.factsStore.all()
      const relatedFacts = factList.filter(f =>
        userMessage.toLowerCase().split(/\s+/)
          .map((w: string) => w.replace(/[^\p{L}\p{N}]/gu, ''))
          .filter(Boolean)
          .some((w: string) => w.length > 3 && f.content.toLowerCase().includes(w))
      )
      if (relatedFacts.length === 0 && userMessage.length > 15) {
        await this.gapService.create({
          userId,
          workspaceId: userId,
          content: userMessage.slice(0, 200),
          source: 'chat',
          sourceId: sessionId,
        })
        await this.telemetry.record({
          userId,
          workspaceId: userId,
          category: 'gap',
          action: 'created',
          metadata: { source: 'chat', sourceId: sessionId },
        }).catch(() => {})
        console.log(`[GAP] Detected: "${userMessage.slice(0, 80)}"`)
      }
    } catch (err) {
      console.log('[GAP] Detection skipped:', (err as Error).message.slice(0, 100))
    }
  }

  /** K1/K2: read the scope cursor, check the incremental segment and
   *  schedule a debounced extraction when it qualifies. */
  private async maybeScheduleIncrementalExtraction(
    userId: string,
    sessionId: string,
    patientHash?: string,
  ): Promise<void> {
    try {
      const { getExtractedUptoIdx, scopeKeyOf, shouldExtractIncrement } = await import('../../memory/extraction-cursor.js')
      const scopeKey: { userId: string; scopeType: 'patient' | 'global'; patientHash?: string } = { userId, scopeType: patientHash ? 'patient' : 'global', patientHash }
      const fromIdx = await getExtractedUptoIdx(scopeKey)
      const incremental = this.eventLog
        .query({ sessionId, afterIdx: fromIdx })
        .filter((e) => e.eventType === 'user_message' || e.eventType === 'assistant_response')
        .map((e) => `${e.eventType === 'user_message' ? 'USER' : 'AI'}: ${String(e.content || '').slice(0, 500)}`)
        .join('\n')

      if (!shouldExtractIncrement(incremental)) return
      const toIdx = this.eventLog.count()

      const mapKey = scopeKeyOf(scopeKey)
      const existing = pendingExtractions.get(mapKey)
      if (existing) clearTimeout(existing)
      pendingExtractions.set(
        mapKey,
        setTimeout(() => {
          pendingExtractions.delete(mapKey)
          this.runIncrementalExtraction(userId, sessionId, patientHash, fromIdx, toIdx)
            .catch((err) => console.log('[EVOLVE] Extraction failed:', (err as Error).message.slice(0, 120)))
        }, 2000).unref?.() as ReturnType<typeof setTimeout>,
      )
    } catch (err) {
      console.log('[EVOLVE] Increment check skipped:', (err as Error).message.slice(0, 120))
    }
  }

  private async runIncrementalExtraction(
    userId: string,
    sessionId: string,
    patientHash: string | undefined,
    fromIdx: number,
    toIdx: number,
  ) {
    const { advanceExtractedUptoIdx, scopeKeyOf } = await import('../../memory/extraction-cursor.js')
    const scopeKey: { userId: string; scopeType: 'patient' | 'global'; patientHash?: string } = { userId, scopeType: patientHash ? 'patient' : 'global', patientHash }
    const incrementalEvents = this.eventLog
      .query({ sessionId, afterIdx: fromIdx })
      .filter((e) => e.eventType === 'user_message' || e.eventType === 'assistant_response')
    const conversation = incrementalEvents
      .map(e => `${e.eventType === 'user_message' ? 'USER' : 'AI'}: ${String(e.content || '').slice(0, 500)}`)
      .join('\n')
    const totalTurns = toIdx

    try {
      const apiKey = getApiKey()

        // Gather context so extracted facts are grounded and not duplicated.
        const existingFacts = this.factsStore.all()
        const relatedFacts = existingFacts
          .filter(f =>
            (patientHash && f.patientHash === patientHash) ||
            conversation.toLowerCase().split(/\s+/).some((w: string) => w.length > 3 && f.content.toLowerCase().includes(w))
          )
          .slice(0, 10)

        const episode = this.episodesStore.all().find(e => e.sessionId === sessionId)
        const contextLines: string[] = []
        if (patientHash) {
          contextLines.push(`Current patient: ${patientHash}`)
          contextLines.push('Facts about this patient should use sourceType: "patient" and include the patientHash.')
        }
        if (episode) {
          contextLines.push(`Session summary so far: ${episode.summary}`)
        }
        if (relatedFacts.length > 0) {
          contextLines.push('Existing related facts (avoid duplicating these unless new details are added):')
          relatedFacts.forEach(f => {
            contextLines.push(`- [${f.sourceType || 'general'}] ${f.content}`)
          })
        }
        const contextBlock = contextLines.length > 0 ? `\n${contextLines.join('\n')}\n` : ''

        const extractionPrompt = `You are a clinical fact extractor for an oncology research assistant.
Extract key, grounded facts from the conversation below. Return ONLY a JSON array of objects with:
- category: preference / fact / constraint / goal / context
- importance: 1-5 (5 = critical for future decisions)
- content: short, self-contained sentence
- sourceType: "patient" (about the current patient), "doctor" (clinician preference/workflow), "research" (studies/trials), "general" (anything else)
${contextBlock}
Conversation:
${conversation}

[JSON array]:`

        const result = await deepseekChat(
          [{ role: 'user', content: extractionPrompt }],
          apiKey,
          {
            model: 'deepseek-chat',
            maxTokens: 2048,
            telemetryContext: { userId, workspaceId: userId, action: 'chat.extract_facts' },
          },
        )
        const jsonMatch = result.match(/\[[\s\S]*\]/)
        if (jsonMatch) {
          const facts = JSON.parse(jsonMatch[0])
          const proposed: string[] = []
          for (const f of facts) {
            if (f.category && f.content) {
              const factInput = {
                category: f.category,
                importance: Math.min(5, Math.max(1, f.importance || 3)),
                content: f.content,
                sourceType: f.sourceType || 'general',
                patientHash: f.sourceType === 'patient' ? (patientHash || undefined) : undefined,
              }
              // AI extraction always goes through the pending review queue
              // (BRAIN2_MEMORY_LIFECYCLE §5.2 — no direct write path).
              proposed.push(f.content)
              await this.proposeFact(userId, patientHash, factInput)
            }
          }
          this.eventLog.append({
            timestamp: Date.now() / 1000,
            eventType: 'evolution',
            content: `🧠 Proposed ${proposed.length} new facts for review`,
            metadata: { factCount: proposed.length, categories: [...new Set(facts.map((f: any) => f.category))] },
            agentId: userId, sessionId,
          })
          console.log(`[EVOLVE] Proposed ${proposed.length} facts for review (turn ${totalTurns})`)

          // Auto-resolve pending gaps that match new facts
          const resolved = await this.autoResolveGapsFromFacts(userId, facts)
          if (resolved.length > 0) console.log(`[GAP] Auto-resolved ${resolved.length} gaps`)

          // Auto-generate knowledge article when 3+ facts accumulate
          const allFacts = this.memory
            ? this.memory.graph.getCurrentNodesByType('fact').filter((n): n is import('../../memory/memory.types').FactNode => n.type === 'fact')
            : this.factsStore.all()
          if (allFacts.length >= 3 && allFacts.length % 5 === 0) {
            try {
              const articleFacts = allFacts.slice(-10)
              const factList = articleFacts
                .map((f) => {
                  const date = f.createdAt ? new Date(f.createdAt).toISOString().slice(0, 10) : 'unknown'
                  const source = [f.sourceType, f.patientHash, f.studyId].filter(Boolean).join(' / ') || 'general'
                  return `[importance=${f.importance ?? 3}] [${f.category}] [${source}] [${date}] ${f.content}`
                })
                .join('\n')
              const articlePrompt = `You are synthesizing clinical findings for an oncology researcher.
Emphasize patient-specific facts, high-importance findings (importance 4-5), and connections across source types (patient / doctor preference / research / general).
Keep the article concise (1-2 paragraphs) and clinically actionable.

Facts to synthesize:
${factList}

Return ONLY JSON: { "title": "...", "content": "..." }`
              const articleResult = await deepseekChat(
                [{ role: 'user', content: articlePrompt }],
                apiKey,
                {
                  model: 'deepseek-chat',
                  maxTokens: 2048,
                  telemetryContext: { userId, workspaceId: userId, action: 'chat.generate_article' },
                },
              )
              const jsonMatch2 = articleResult.match(/\{[\s\S]*\}/)
              if (jsonMatch2) {
                const article = JSON.parse(jsonMatch2[0])
                if (article.title && article.content) {
                  // Synthesized articles also go through the pending review
                  // queue (BRAIN2_MEMORY_LIFECYCLE §5.4).
                  try {
                    const { MemoryGraphGateway } = await import('../../memory/memory-gateway.js')
                    const gateway = new MemoryGraphGateway(
                      userId,
                      this.memory!,
                      this.factsStore,
                      this.episodesStore,
                      this.skillsStore,
                      this.knowledgeStore,
                    )
                    await gateway.propose({
                      scopeType: patientHash ? 'patient' : 'global',
                      patientHash,
                      kind: 'article',
                      content: `${article.title}\n\n${article.content}`,
                      importance: 3,
                      confidence: 'medium',
                      reason: `AI synthesis from ${articleFacts.length} facts`,
                    })
                    console.log(`[KNOWLEDGE] Article proposed for review: ${article.title}`)
                  } catch (err) {
                    console.log('[KNOWLEDGE] Article proposal skipped:', (err as Error).message.slice(0, 100))
                  }
                }
              }
            } catch (err) {
              console.log('[KNOWLEDGE] Article generation skipped:', (err as Error).message.slice(0, 100))
          }
        }
      }
      // Advance the cursor on success (extraction ran; a throw above skips
      // the advance so the segment is retried).
      await advanceExtractedUptoIdx(scopeKey, toIdx)
      console.log(`[EVOLVE] Increment extracted (idx ${fromIdx} → ${toIdx})`)
    } catch (err) {
      console.log('[EVOLVE] Fact extraction skipped:', (err as Error).message.slice(0, 100))
    }
  }

  /**
   * Auto-resolve open gaps when new facts match their query keywords.
   */
  private async autoResolveGapsFromFacts(
    userId: string,
    newFacts: Array<{ content: string }>,
  ): Promise<string[]> {
    const { gaps: openGaps } = await this.gapService.list({ workspaceId: userId, status: 'open' })
    const resolved: string[] = []
    for (const gap of openGaps) {
      const words = gap.content.toLowerCase().split(/\s+/).filter(w => w.length > 3)
      const matched = newFacts.some(f => words.some(w => f.content.toLowerCase().includes(w)))
      if (matched) {
        await this.gapService.resolve(gap.id, `Auto-resolved by fact extraction`)
        await this.telemetry.record({
          userId,
          workspaceId: userId,
          category: 'gap',
          action: 'auto_resolved',
          metadata: { gapId: gap.id },
        }).catch(() => {})
        resolved.push(gap.id)
      }
    }
    return resolved
  }
}
