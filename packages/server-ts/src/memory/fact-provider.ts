/**
 * #637 阶段 3 — FactProvider 适配器。
 *
 * 双 store(facts 的 legacy FactsStore / memory graph FactNode)收敛为
 * 同一接口:注入层与投影层只依赖 FactProvider,不再关心事实来源。
 * #627 的跨 store 去重(factContentHash)也统一从这里产出。
 */
import type { FactsStore } from '../evolution/stores.js'
import { factContentHash } from '../common/fact-render.js'
import type { MemoryGraph } from './memory.graph.js'

export interface ScoredFact {
  content: string
  category: string
  importance: number
  confidence?: number
  provenance?: { sourceKind?: string }
  patientHash?: string
  /** #840-r5: study 域事实的隔离口径(persona 过滤 !studyId) — graph 路此前丢失该字段。 */
  studyId?: string
  /** 跨 store 去重 key — content+category+patientHash(#627)。 */
  factHash: string
  createdAt?: number
  /** 来源标识(如 fact:abc) — 检索结果追踪用。 */
  source?: string
  /**
   * #748: 图谱稳定ID — 词法/向量两路检索的统一主键,RRF 以此合并同一事实。
   */
  stableId?: string
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
      // #748: legacy id === graph stableId (legacy-projection maps 1:1).
      stableId: f.id,
    }))
  }
}

/**
 * #840: graph FactNode 适配器 — keyword 检索路切 graph 的读侧实现。
 * graph 是单一事实源;legacy FactsStore 降级为投影缓存(fallback)。
 * getCurrentNodesByType 已滤 superseded(与 listCurrent 语义一致)。
 */
export class GraphFactProvider implements FactProvider {
  constructor(private graph: MemoryGraph) {}

  listCurrent(opts?: { patientHash?: string | null }): ScoredFact[] {
    const nodes = this.graph.getCurrentNodesByType('fact') as Array<Record<string, any>>
    return nodes
      .filter((n) => (opts?.patientHash ? n.patientHash === opts.patientHash : true))
      .map((n) => ({
        content: String(n.content || ''),
        category: String(n.category || 'fact'),
        importance: Number(n.importance) || 3,
        confidence: n.confidence,
        provenance: n.provenance,
        patientHash: n.patientHash,
        studyId: n.studyId,
        factHash: factContentHash({ content: String(n.content || ''), category: n.category, patientHash: n.patientHash }),
        createdAt: typeof n.createdAt === 'string' ? Date.parse(n.createdAt) : n.createdAt,
        source: `fact:${n.stableId}`,
        stableId: n.stableId,
      }))
  }
}
