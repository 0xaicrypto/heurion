import { EventLog, Event } from '../../core/event-log'
import { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../../evolution/stores'
import { ContractEngine } from '../../core/contracts'
import { MemoryProjection } from '../../retrieval/memory-projection'
import { deepseekChat, getApiKey } from '../../common/llm.js'
import { router, RouterResult } from '../../retrieval/query-router'
import { handleKnowledgeCommand, CommandResult } from '../knowledge/knowledge-command-handler.js'
import { PrismaKnowledgeGapService } from '../knowledge/knowledge-gap.service.js'
import { type TelemetryService, NoopTelemetryService } from '../knowledge/telemetry.service.js'

export interface TurnResult {
  userEvent: Event
  response: string
  budget: any[]
  route?: RouterResult
  kbCommand?: boolean
}

export class ChatOrchestrator {
  private projection: MemoryProjection
  private gapService = new PrismaKnowledgeGapService()

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
      userId, patientHash, sessionId, persona, routeResult,
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
    patientHash: string | null
    sessionId: string
    persona: string
    routeResult: RouterResult
  }) {
    const { userId, patientHash, sessionId, persona, routeResult } = params

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
      // Guideline / knowledge questions: skip episodic chat history, keep facts + knowledge
      episodes = []
      skills = []
    } else if (routeResult.intent === 'file') {
      // File references are handled upstream; keep minimal context here
      facts = []
      episodes = []
      skills = []
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

  // #2: Extract facts automatically using DeepSeek
  async postTurn(userId: string, sessionId: string, userMessage: string, patientHash?: string) {
    const recentEvents = this.eventLog.query({ sessionId, limit: 6 }).reverse()
    const conversation = recentEvents
      .map(e => `${e.eventType === 'user_message' ? 'USER' : 'AI'}: ${e.content.slice(0, 300)}`)
      .join('\n')

    // A "turn" is one complete user-message + assistant-response pair.
    // EventLog stores each as a separate event, so divide by 2.
    const sessionEvents = this.eventLog.query({ sessionId })
    const turnCount = Math.floor(sessionEvents.length / 2)
    this.episodesStore.upsert(sessionId, userMessage.slice(0, 150), turnCount)

    const totalTurns = turnCount
    if (totalTurns % 5 === 0 && totalTurns > 0) {
      try {
        const apiKey = getApiKey()
        const patientCtx = patientHash
          ? '\nCurrent context: discussing patient ' + patientHash + '. Facts about this patient should have sourceType: "patient" and patientHash set.'
          : ''
        const extractionPrompt = `Extract key facts from this clinical conversation. Return ONLY a JSON array of objects with:
- category: preference/fact/constraint/goal/context
- importance: 1-5
- content: short sentence
- sourceType: "patient" (if about a specific patient), "doctor" (if about doctor's preference/workflow), "research" (if about studies/trials), "general" (otherwise)
${patientCtx}\n\n${conversation}\n\n[JSON array]:`

        const result = await deepseekChat([{ role: 'user', content: extractionPrompt }], apiKey)
        const jsonMatch = result.match(/\[[\s\S]*\]/)
        if (jsonMatch) {
          const facts = JSON.parse(jsonMatch[0])
          for (const f of facts) {
            if (f.category && f.content) {
              this.factsStore.add({
                category: f.category,
                importance: Math.min(5, Math.max(1, f.importance || 3)),
                content: f.content,
                sourceType: f.sourceType || 'general',
                patientHash: f.sourceType === 'patient' ? (patientHash || undefined) : undefined,
              })
            }
          }
          this.factsStore.commit()
          this.eventLog.append({
            timestamp: Date.now() / 1000,
            eventType: 'evolution',
            content: `🧠 Extracted ${facts.length} new facts`,
            metadata: { factCount: facts.length, categories: [...new Set(facts.map((f: any) => f.category))] },
            agentId: userId, sessionId,
          })
          console.log(`[EVOLVE] Extracted ${facts.length} facts (turn ${totalTurns})`)

          // Auto-resolve pending gaps that match new facts
          const resolved = await this.autoResolveGapsFromFacts(userId, facts)
          if (resolved.length > 0) console.log(`[GAP] Auto-resolved ${resolved.length} gaps`)

          // Auto-generate knowledge article when 3+ facts accumulate
          const allFacts = this.factsStore.all()
          if (allFacts.length >= 3 && allFacts.length % 5 === 0) {
            try {
              const articleFacts = allFacts.slice(-10)
              const factList = articleFacts
                .map((f) => {
                  const date = f.createdAt ? new Date(f.createdAt * 1000).toISOString().slice(0, 10) : 'unknown'
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
              const articleResult = await deepseekChat([{ role: 'user', content: articlePrompt }], apiKey)
              const jsonMatch2 = articleResult.match(/\{[\s\S]*\}/)
              if (jsonMatch2) {
                const article = JSON.parse(jsonMatch2[0])
                if (article.title && article.content) {
                  this.knowledgeStore.add({
                    title: article.title,
                    content: article.content,
                    sources: articleFacts.map((f: any) => f.id),
                  })
                  this.knowledgeStore.commit()
                  console.log(`[KNOWLEDGE] Article generated: ${article.title}`)
                }
              }
            } catch (err) {
              console.log('[KNOWLEDGE] Article generation skipped:', (err as Error).message.slice(0, 100))
            }
          }
        }
      } catch (err) {
        console.log('[EVOLVE] Fact extraction skipped:', (err as Error).message.slice(0, 100))
      }
    }

    // Detect knowledge gaps on every turn — queries with no matching facts
    try {
      const relatedFacts = this.factsStore.all().filter(f =>
        userMessage.toLowerCase().split(/\s+/)
          .map(w => w.replace(/[^\p{L}\p{N}]/gu, ''))
          .filter(Boolean)
          .some(w => w.length > 3 && f.content.toLowerCase().includes(w))
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
