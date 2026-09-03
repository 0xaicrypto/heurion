/**
 * #816 — facts→article 覆盖率:记忆系统的健康度量与合成调度依据。
 *
 * 口径(患者隔离,BRAIN2_MEMORY_LIFECYCLE §4.2):
 * - patient scope  → 只统计该患者的 facts;
 * - study scope    → 只统计该研究的 facts;
 * - global scope   → 只统计无 patientHash 且无 studyId 的 facts
 *   (K4 缺陷①修复:此前空 scope 会把所有患者的 facts 混入"全局"统计)。
 *
 * 覆盖 = fact stableId 被 ≥1 篇 current article 的 sourceFacts 引用,
 * 或被 pending 的 article 提案占用(K4 缺陷②:审批前同批 facts 不再
 * 重复触发合成 — pending 是"已在路上"的覆盖)。
 *
 * 实时性:fact 审批通过 / article 落库 / supersede 失效传播都直接改变
 * graph 状态,本函数每次从 graph 现算(无缓存即无失效问题,#816 验收
 * 要求的"实时变化"由此保证;规模 ≤ 数千节点,O(N) 现算足够)。
 */
import prisma from '../common/prisma.js'
import type { MemoryService } from './memory.service.js'
import type { FactNode, ArticleNode } from './memory.types.js'

export interface CoverageScope {
  patientHash?: string
  studyId?: string
}

export interface ScopeCoverage {
  scope: 'patient' | 'study' | 'global'
  patientHash?: string
  studyId?: string
  confirmedFacts: number
  coveredFacts: number
  /** 0-1;无可覆盖事实(0 条)时约定为 1(没有缺口)。 */
  ratio: number
  /** 未覆盖 facts 的内容样本(供 UI 提示,按重要性降序,≤5 条)。 */
  uncoveredSample: string[]
}

/** 待审 article 提案占用的 fact stableIds(pending 即"覆盖在路上")。 */
export async function getPendingOccupiedFactIds(userId: string, scope: CoverageScope): Promise<Set<string>> {
  const where: any = { userId, status: 'pending', kind: 'article' }
  if (scope.patientHash) {
    where.scopeType = 'patient'
    where.patientHash = scope.patientHash
  } else if (scope.studyId) {
    where.scopeType = 'study'
    where.studyId = scope.studyId
  } else {
    where.scopeType = 'global'
  }
  try {
    const rows = await (prisma as any).memoryProposal.findMany({ where, select: { relatedFacts: true } })
    const ids = new Set<string>()
    for (const row of rows) {
      if (!row.relatedFacts) continue
      try {
        const parsed = JSON.parse(row.relatedFacts)
        if (Array.isArray(parsed)) for (const id of parsed) ids.add(String(id))
      } catch { /* malformed row — skip */ }
    }
    return ids
  } catch {
    // 表缺失/库不可达 → 空集(覆盖率退化为仅 current article 口径)
    return new Set()
  }
}

function scopeKey(scope: CoverageScope): ScopeCoverage['scope'] {
  return scope.patientHash ? 'patient' : scope.studyId ? 'study' : 'global'
}

/** 单 scope 覆盖率 — 所有覆盖度量的唯一实现。 */
export async function computeScopeCoverage(userId: string, memory: MemoryService, scope: CoverageScope): Promise<ScopeCoverage> {
  const facts = memory.graph.getCurrentNodesByType('fact') as FactNode[]
  const scoped = facts.filter((f) =>
    scope.patientHash ? f.patientHash === scope.patientHash
      : scope.studyId ? f.studyId === scope.studyId
        : !f.patientHash && !f.studyId,
  )

  const used = new Set<string>()
  for (const a of memory.graph.getCurrentNodesByType('article') as ArticleNode[]) {
    for (const sf of a.sourceFacts || []) used.add(sf.stableId)
  }
  for (const id of await getPendingOccupiedFactIds(userId, scope)) used.add(id)

  const uncovered = scoped.filter((f) => !used.has(f.stableId))
  const sortedUncovered = [...uncovered].sort((a, b) => (b.importance ?? 3) - (a.importance ?? 3))
  return {
    scope: scopeKey(scope),
    patientHash: scope.patientHash,
    studyId: scope.studyId,
    confirmedFacts: scoped.length,
    coveredFacts: scoped.length - uncovered.length,
    ratio: scoped.length === 0 ? 1 : (scoped.length - uncovered.length) / scoped.length,
    uncoveredSample: sortedUncovered.slice(0, 5).map((f) => f.content),
  }
}

export interface CoverageDashboard {
  global: ScopeCoverage
  patients: Array<ScopeCoverage>
  /** 覆盖率低于此阈值时 UI 提示沉淀/手动合成(#816)。 */
  hintThreshold: number
}

const COVERAGE_HINT_THRESHOLD = 0.6
/** 仪表盘展开的患者 scope 数上限(全量见患者页)。 */
const PATIENT_SCOPE_MAX = 20

/**
 * 覆盖率仪表盘:global + 各患者 scope(按未覆盖数降序取前 N)。
 * study scope 由研究页按需单查,不在仪表盘全量展开。
 */
export async function buildCoverageDashboard(userId: string, memory: MemoryService): Promise<CoverageDashboard> {
  const global = await computeScopeCoverage(userId, memory, {})
  const facts = memory.graph.getCurrentNodesByType('fact') as FactNode[]
  const patientHashes = Array.from(new Set(facts.map((f) => f.patientHash).filter((h): h is string => !!h)))
  const patients: ScopeCoverage[] = []
  for (const patientHash of patientHashes.slice(0, PATIENT_SCOPE_MAX)) {
    patients.push(await computeScopeCoverage(userId, memory, { patientHash }))
  }
  patients.sort((a, b) => (a.ratio - b.ratio))
  return { global, patients, hintThreshold: COVERAGE_HINT_THRESHOLD }
}
