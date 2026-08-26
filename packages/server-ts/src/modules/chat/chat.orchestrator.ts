import { EventLog } from '../../core/event-log'
import { makeLogger } from '../../common/logger.js'
import { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../../evolution/stores'
import { MemoryProjection } from '../../retrieval/memory-projection'
import { PrismaKnowledgeGapService } from '../knowledge/knowledge-gap.service.js'
import { type TelemetryService, NoopTelemetryService } from '../knowledge/telemetry.service.js'
import type { MemoryService } from '../../memory/memory.service.js'


const log = makeLogger('chat.orchestrator')

export class ChatOrchestrator {
  /** #646: read by conversation-turn / chat.router — no private-access hack. */
  readonly projection = new MemoryProjection()
  private gapService = new PrismaKnowledgeGapService()

  constructor(
    private eventLog: EventLog,
    private factsStore: FactsStore,
    private episodesStore: EpisodesStore,
    private skillsStore: SkillsStore,
    private knowledgeStore: KnowledgeStore,
    private telemetry: TelemetryService = new NoopTelemetryService(),
    /** §5.2 (#190): constructor-injected — no more (this as any).memory. */
    private memory?: MemoryService,
  ) {
  }

  // #2: Extract facts automatically using DeepSeek (K1/K2: incremental
  // cursor + event-driven trigger, debounced 2s per scope).
  async postTurn(userId: string, sessionId: string, userMessage: string, patientHash?: string) {
    const sessionEvents = this.eventLog.query({ sessionId })
    // Turns = user messages only; tool_call/tool_result events (R3) must
    // not inflate the count.
    const turnCount = sessionEvents.filter((e) => e.eventType === 'user_message').length
    // #737: the raw message goes into its own lastMessage slot — never into
    // `summary`, which compaction/summarizer own. Explicit commit keeps
    // in-memory and on-disk stores consistent.
    this.episodesStore.upsert(sessionId, '', turnCount)
    this.episodesStore.recordRecentMessage(sessionId, userMessage)
    this.episodesStore.commit()

    // K6 (#645): gap detection lives in knowledge-gap.service (single
    // source); postTurn just reports the outcome for telemetry/logging.
    try {
      const factList = this.memory
        ? this.memory.graph.getCurrentNodesByType('fact').filter((n): n is import('../../memory/memory.types').FactNode => n.type === 'fact')
        : this.factsStore.all()
      const created = await this.gapService.detectFromChat({
        userId,
        sessionId,
        message: userMessage,
        facts: factList,
      })
      if (created) {
        await this.telemetry.record({
          userId,
          workspaceId: userId,
          category: 'gap',
          action: 'created',
          metadata: { source: 'chat', sourceId: sessionId },
        }).catch(() => {})
        log.info(`gap detected: "${userMessage.slice(0, 80)}"`)
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
      const { flushUnextracted } = await import('../../memory/compaction/index.js')
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
