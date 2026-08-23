/**
 * #637 阶段 3 — FactProvider 适配器。
 *
 * 双 store(facts 的 legacy FactsStore / memory graph FactNode)收敛为
 * 同一接口:注入层与投影层只依赖 FactProvider,不再关心事实来源。
 * #627 的跨 store 去重(factContentHash)也统一从这里产出。
 */
import type { FactsStore } from '../evolution/stores.js'
import type { MemoryGraph } from './memory.graph.js'
import type { FactNode } from './memory.types.js'
import { factContentHash } from '../common/fact-render.js'

export interface ScoredFact {
  content: string
  category: string
  importance: number
  confidence?: number
  provenance?: { sourceKind?: string }
  patientHash?: string
  /** 跨 store 去重 key — content+category+patientHash(#627)。 */
  factHash: string
  createdAt?: number
  /** 来源标识(如 fact:abc) — 检索结果追踪用。 */
  source?: string
}

export interface FactProvider {
  /** 当前生效的事实列表(排序由调用方决定)。patientHash 可选过滤。 */
  listCurrent(opts?: { patientHash?: string | null }): ScoredFact[]
}

/** legacy FactsStore 适配器。 */
export class LegacyFactProvider implements FactProvider {
  constructor(private store: FactsStore) {}

  listCurrent(opts?: { patientHash?: string | null }): ScoredFact[] {
    let facts = this.store.all()
    if (opts?.patientHash) facts = facts.filter((f) => f.patientHash === opts.patientHash)
    return facts.map((f) => ({
      content: f.content,
      category: f.category,
      importance: f.importance,
      confidence: f.confidence,
      provenance: f.provenance,
      patientHash: f.patientHash,
      factHash: factContentHash(f),
      createdAt: f.createdAt,
      source: `fact:${f.id}`,
    }))
  }
}

/** memory graph FactNode 适配器(稳定 ID + contentHash 全生命周期)。 */
export class GraphFactProvider implements FactProvider {
  constructor(private graph: MemoryGraph) {}

  listCurrent(opts?: { patientHash?: string | null }): ScoredFact[] {
    const nodes = this.graph.getCurrentNodesByType('fact') as FactNode[]
    const filtered = opts?.patientHash ? nodes.filter((n) => n.patientHash === opts.patientHash) : nodes
    return filtered.map((n) => ({
      content: n.content,
      category: n.category,
      importance: n.importance ?? 3,
      confidence: n.provenance.confidence,
      provenance: { sourceKind: n.provenance.sourceKind },
      patientHash: n.patientHash,
      factHash: factContentHash(n),
      createdAt: n.createdAt,
      source: `fact:${n.stableId}`,
    }))
  }
}
