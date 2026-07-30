import type { MemoryService } from '../../memory/memory.service.js'
import type { EventLog } from '../../core/event-log.js'
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
        model: 'deepseek-chat',
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

      this.memory.addFact({
        category: category as 'fact' | 'context',
        importance: Math.round(entity.confidence * 5),
        content: entity.content.label,
        sourceType: sourceType as 'patient' | 'doctor' | 'research' | 'general',
        patientHash,
        confidence: entity.confidence,
        provenance: {
          sourceKind: 'chat',
          sourceRef: encounterId,
          evidenceQuote: entity.evidence_quote,
        },
      }, 'system')
      emitted++
    }

    this.eventLog.append({
      timestamp: Date.now() / 1000,
      eventType: 'ingestion_completed',
      content: `Ingestion complete: ${emitted} entities stored`,
      metadata: {
        encounterId,
        emittedCount: emitted,
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
