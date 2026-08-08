import type { MemoryService } from '../../memory/memory.service.js'
import type { EventLog } from '../../core/event-log.js'
import type { MemoryGraphGateway } from '../../memory/memory-gateway.js'
import { extractClinicalEntities, type ClinicalEntity, type ExtractionResult } from './clinical-extractor.service.js'

export interface IngestOptions {
  userId: string
  patientHash?: string
  encounterId: string
  sourceText: string
  sourceEventIdx?: number
}

export class ChatIngester {
  constructor(
    private memory: MemoryService,
    private eventLog: EventLog,
    private gateway: MemoryGraphGateway,
  ) {}

  async ingestEncounter(opts: IngestOptions): Promise<{
    emitted: number
    rawCount: number
    drops: Record<string, number>
    entities: ClinicalEntity[]
  }> {
    const { userId, patientHash, encounterId, sourceText, sourceEventIdx } = opts
    if (!sourceText) return { emitted: 0, rawCount: 0, drops: {}, entities: [] }

    const result = await extractClinicalEntities(sourceText)

    this.eventLog.append({
      timestamp: Date.now() / 1000,
      eventType: 'ingestion_llm_response',
      content: `Extracted ${result.entities.length} entities from chat`,
      metadata: {
        model: (await import('../../common/llm.js')).DEEPSEEK_CHAT_MODEL,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        latencyMs: result.latencyMs,
        rawCount: result.rawCount,
        drops: result.drops,
      },
      agentId: userId,
      sessionId: encounterId,
    })

    let emitted = 0
    let deduped = 0
    for (const entity of result.entities) {
      const category = entity.node_type === 'med' ? 'fact'
        : entity.node_type === 'ddx' ? 'context'
        : entity.node_type === 'measurement' ? 'fact'
        : entity.node_type === 'finding' ? 'context'
        : 'fact'
      const sourceType = entity.node_type === 'finding' ? 'patient'
        : entity.node_type === 'med' ? 'research'
        : entity.node_type === 'ddx' ? 'doctor'
        : 'general'

      // §4.5 (#186): every write goes through the review queue — no direct
      // addFact path. The gateway also semantically dedups (0.95, same scope).
      const proposal = await this.gateway.propose({
        scopeType: patientHash ? 'patient' : 'global',
        patientHash,
        kind: 'fact',
        content: entity.content.label,
        importance: Math.round(entity.confidence * 5),
        confidence: entity.confidence >= 0.6 ? 'high' : 'medium',
        reason: `聊天/手动导入：${entity.content.label}`,
        sourceRange: entity.evidence_quote || undefined,
        category,
        conflictsWith: undefined,
      })
      if (proposal.status === 'pending') {
        emitted++
      } else {
        deduped++
      }
    }

    this.eventLog.append({
      timestamp: Date.now() / 1000,
      eventType: 'ingestion_completed',
      content: `Ingestion complete: ${emitted} entities proposed (${deduped} deduped)`,
      metadata: {
        encounterId,
        emittedCount: emitted,
        dedupedCount: deduped,
        drops: result.drops,
        rawCount: result.rawCount,
      },
      agentId: userId,
      sessionId: encounterId,
    })

    return {
      emitted,
      rawCount: result.rawCount,
      drops: result.drops,
      entities: result.entities,
    }
  }
}
