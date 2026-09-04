/**
 * Shared collaborator plumbing for the per-node-type memory services
 * (#682). Fact/Summary/Document/Gap services each handle their own node
 * type but share: graph + legacy projection + propagation + curation +
 * event log, and the dual-store atomicity helpers.
 */
import { createHash, randomUUID } from 'crypto'
import type { EventLog } from '../core/event-log'
import type { FactsStore, KnowledgeStore } from '../evolution/stores'
import { MemoryGraph } from './memory.graph'
import { LegacyProjection, type LegacySnapshot } from './legacy-projection.js'
import { PropagationCoordinator } from './propagation-coordinator.js'
import { CurationEngine } from './curation/curation.engine'

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

export function newStableId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export function newNodeId(stableId: string, version: number): string {
  return `${stableId}@v${version}`
}

export interface MemoryCollaborators {
  eventLog: EventLog
  graph: MemoryGraph
  curation: CurationEngine
  legacyProjection: LegacyProjection
  propagation: PropagationCoordinator
  legacyFacts: FactsStore
  legacyKnowledge: KnowledgeStore
  ownerId: string
  /** #439: derived-index sync hook (embedding vectors etc.). */
  onNodeRemoved?: (stableId: string, type: string) => void
}

export abstract class MemoryNodeService {
  constructor(protected readonly c: MemoryCollaborators) {}

  /** #304: delegate to LegacyProjection. */
  protected snapshotLegacy(): LegacySnapshot {
    return this.c.legacyProjection.snapshot()
  }

  /** #304: delegate to PropagationCoordinator (graph-commit-last atomicity). */
  protected commitGraphLast(legacyBefore: LegacySnapshot) {
    this.c.propagation.commit(legacyBefore)
  }

  protected applyPropagationToLegacy(propagation: {
    staleSummaryStableIds: string[]
    supersededFactStableIds: string[]
    reopenedGapStableIds: string[]
  }) {
    this.c.legacyProjection.applyPropagation(propagation)
  }

  protected appendEvent(eventType: string, content: string, metadata: Record<string, unknown>) {
    this.c.eventLog.append({
      timestamp: Date.now() / 1000,
      eventType,
      content,
      metadata,
      agentId: this.c.ownerId,
      sessionId: 'memory',
    })
  }
}

export function buildMemoryCollaborators(opts: {
  eventLog: EventLog
  baseDir: string
  legacyFacts: FactsStore
  legacyKnowledge: KnowledgeStore
  ownerId: string
  onNodeRemoved?: (stableId: string, type: string) => void
}): MemoryCollaborators {
  const graph = new MemoryGraph(opts.baseDir)
  const curation = new CurationEngine(graph)
  const legacyProjection = new LegacyProjection(opts.legacyFacts, opts.legacyKnowledge, graph)
  const propagation = new PropagationCoordinator(legacyProjection, graph)
  return {
    eventLog: opts.eventLog,
    graph,
    curation,
    legacyProjection,
    propagation,
    legacyFacts: opts.legacyFacts,
    legacyKnowledge: opts.legacyKnowledge,
    ownerId: opts.ownerId,
    onNodeRemoved: opts.onNodeRemoved,
  }
}
