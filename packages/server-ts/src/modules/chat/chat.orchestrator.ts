import { EventLog, Event } from '../../core/event-log'
import { makeLogger } from '../../common/logger.js'
import { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../../evolution/stores'
import { ContractEngine } from '../../core/contracts'
import { MemoryProjection } from '../../retrieval/memory-projection'

/** CJK-aware keyword extraction: latin tokens as-is, Chinese via 2-grams
 *  (split(/\s+/) does not segment Chinese — a whole sentence becomes one
 *  token and keyword overlap never matches). Stopwords are dropped. */
function extractCjkKeywords(text: string): string[] {
  const clean = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')
  const STOP = /^(患者|病人|医生|这个|那个|我们|你们|他们|请问|没有|一下|的话)$/
  const words = new Set<string>()
  for (const token of clean.split(/\s+/)) {
    if (!token) continue
    if (/[\p{Script=Han}]/u.test(token)) {
      for (let i = 0; i < token.length - 1; i++) {
        const bigram = token.slice(i, i + 2)
        if (!STOP.test(bigram) && /[\p{Script=Han}]/u.test(bigram)) words.add(bigram)
      }
    } else if (token.length >= 2 && token.length <= 6) {
      words.add(token)
    }
  }
  return [...words]
}
import { handleKnowledgeCommand, CommandResult } from '../knowledge/knowledge-command-handler.js'
import { PrismaKnowledgeGapService } from '../knowledge/knowledge-gap.service.js'
import { type TelemetryService, NoopTelemetryService } from '../knowledge/telemetry.service.js'
import type { MemoryService } from '../../memory/memory.service.js'


const log = makeLogger('chat.orchestrator')

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
  }

  constructor(
    private eventLog: EventLog,
    private factsStore: FactsStore,
    private episodesStore: EpisodesStore,
    private skillsStore: SkillsStore,
    private knowledgeStore: KnowledgeStore,
    private contracts: ContractEngine,
    private telemetry: TelemetryService = new NoopTelemetryService(),
    /** §5.2 (#190): constructor-injected — no more (this as any).memory. */
    private memory?: MemoryService,
  ) {
    this.projection = new MemoryProjection(eventLog)
  }

  // #2: Extract facts automatically using DeepSeek (K1/K2: incremental
  // cursor + event-driven trigger, debounced 2s per scope).
  async postTurn(userId: string, sessionId: string, userMessage: string, patientHash?: string) {
    const sessionEvents = this.eventLog.query({ sessionId })
    // Turns = user messages only; tool_call/tool_result events (R3) must
    // not inflate the count.
    const turnCount = sessionEvents.filter((e) => e.eventType === 'user_message').length
    this.episodesStore.upsert(sessionId, userMessage.slice(0, 150), turnCount)

    // K6: Detect knowledge gaps on every turn — question-shaped messages
    // (containing ?/？/如何/是否/为什么…) not covered by any fact.
    try {
      const QUESTION_RE = /[?？]|如何|怎样|怎么|为什么|为何|是否|是不是|有没有|是什么|哪些|哪个/
      const factList = this.memory
        ? this.memory.graph.getCurrentNodesByType('fact').filter((n): n is import('../../memory/memory.types').FactNode => n.type === 'fact')
        : this.factsStore.all()
      const gapKeywords = extractCjkKeywords(userMessage)
      const relatedFacts = factList.filter(f =>
        gapKeywords.some(w => f.content.toLowerCase().includes(w))
      )
      if (relatedFacts.length === 0 && QUESTION_RE.test(userMessage) && userMessage.length > 5) {
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
      log.warn('gap detection skipped', { reason: (err as Error).message.slice(0, 100) })
    }
  }

  /**
   * Tier 3 — exposed for the session-close flow: extract any conversation
   * segment not yet covered by the cursor or a compaction.
   */
  async extractUnextractedSegment(userId: string, sessionId: string, patientHash?: string): Promise<number> {
    try {
      const { flushUnextracted } = await import('../../memory/compaction.js')
      return await flushUnextracted(
        {
          userId,
          eventLog: this.eventLog,
          facts: this.factsStore,
          episodes: this.episodesStore,
          skills: this.skillsStore,
          knowledge: this.knowledgeStore,
          memory: this.memory,
        },
        sessionId,
        patientHash,
      )
    } catch (err) {
      log.warn('flush skipped', { reason: (err as Error).message.slice(0, 120) })
      return 0
    }
  }


}
