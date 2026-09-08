/**
 * #849/D1 — JournalRepository:数据与逻辑分离的期刊仓储。
 * seed 快照保证离线可用;#852 动态层(OpenAlex/DOAJ)按需补充,失败回落 seed。
 * D5:预警名单快照注入 warnings,任何推荐路径不得绕过。
 */
import type { JournalRecord, JournalWarning } from './journal-types.js'
import { CAS_WARNING_LIST, normalizeJournalName } from './journal-warning-list.js'
import { JOURNAL_SEED, SEED_META, type SeedEntry } from './journal-seed.js'
import { buildMonogram } from './journal-monogram.js'

const STALE_MONTHS = 18

function monthsBetween(from: string, to: Date): number {
  const d = new Date(`${from}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return 0
  return (to.getUTCFullYear() - d.getUTCFullYear()) * 12 + (to.getUTCMonth() - d.getUTCMonth())
}

/** 快照超期 > 18 个月 → stale(D2:宁可标注旧,不可假装新)。 */
export function isSnapshotStale(asOf: string, now = new Date()): boolean {
  return monthsBetween(asOf, now) > STALE_MONTHS
}

function buildRecord(entry: SeedEntry): JournalRecord {
  const metrics: JournalRecord['metrics'] = {}
  if (entry.if !== undefined) {
    metrics.impactFactor = { value: entry.if, asOf: SEED_META.impactFactorAsOf, source: 'jcr_snapshot' }
  }
  if (entry.cas) {
    metrics.casZone = { value: entry.cas, asOf: SEED_META.casZoneAsOf, source: 'cas_snapshot' }
  }
  if (entry.acc !== undefined) {
    metrics.acceptanceRate = { value: entry.acc, asOf: SEED_META.estimateAsOf, source: 'curated_estimate' }
  }
  if (entry.wk !== undefined) {
    metrics.reviewWeeksMedian = { value: entry.wk, asOf: SEED_META.estimateAsOf, source: 'curated_estimate' }
  }
  if (entry.oa) {
    metrics.apc = entry.apc !== undefined
      ? { value: entry.apc, currency: 'USD', asOf: SEED_META.apcAsOf, source: 'doaj_snapshot' }
      : undefined
    if (!metrics.apc) delete metrics.apc
  }
  const now = new Date().toISOString().slice(0, 10)
  return {
    id: entry.id,
    name: entry.name,
    issn: entry.issn,
    publisher: entry.publisher,
    zhName: entry.zh,
    description: entry.desc,
    metrics,
    scope: entry.scope,
    keywords: entry.keywords ?? [],
    articleTypes: entry.types ?? [],
    oa: entry.oa,
    guideUrl: entry.guideUrl,
    warnings: [],
    logo: buildMonogram(entry.name),
    freshness: { seed: true, updatedAt: now, stale: false },
  }
}

/** 预警名单(按归一化刊名)→ warnings 注入 + stale 标注。 */
function attachWarnings(record: JournalRecord): JournalRecord {
  const norm = normalizeJournalName(record.name)
  const warnings: JournalWarning[] = []
  for (const entry of CAS_WARNING_LIST.entries) {
    if (normalizeJournalName(entry.name) === norm) {
      warnings.push({ kind: 'cas_warning_list', asOf: CAS_WARNING_LIST.asOf, note: entry.note })
    }
  }
  if (record.metrics.impactFactor && isSnapshotStale(record.metrics.impactFactor.asOf)) {
    record.freshness.stale = true
  }
  record.warnings = warnings
  return record
}

export class JournalRepository {
  private byId = new Map<string, JournalRecord>()

  constructor(seed: SeedEntry[] = JOURNAL_SEED) {
    for (const entry of seed) {
      this.byId.set(entry.id, attachWarnings(buildRecord(entry)))
    }
  }

  get count(): number {
    return this.byId.size
  }

  get(id: string): JournalRecord | null {
    return this.byId.get(id) ?? null
  }

  listAll(): JournalRecord[] {
    return [...this.byId.values()]
  }

  /** 关键词检索:刊名/中文名/关键词/scope 全字段子串匹配。 */
  search(keyword: string): JournalRecord[] {
    const q = keyword.trim().toLowerCase()
    if (!q) return []
    return this.listAll().filter((j) =>
      j.name.toLowerCase().includes(q)
      || (j.zhName && j.zhName.toLowerCase().includes(q))
      || (j.publisher && j.publisher.toLowerCase().includes(q))
      || j.keywords.some((k) => k.toLowerCase().includes(q))
      || j.scope.some((s) => s.toLowerCase().includes(q)),
    )
  }

  listByScope(scope: string): JournalRecord[] {
    const s = scope.trim().toLowerCase()
    if (!s) return []
    return this.listAll().filter((j) => j.scope.includes(s))
  }

  listByIssn(issn: string): JournalRecord | null {
    const norm = issn.replace(/[^0-9Xx]/g, '').toUpperCase()
    return this.listAll().find((j) => j.issn && j.issn.replace(/[^0-9Xx]/g, '').toUpperCase() === norm) ?? null
  }

  /** 预警期刊(D5 红线区数据源)。 */
  listWarned(): JournalRecord[] {
    return this.listAll().filter((j) => j.warnings.length > 0)
  }
}

let repositorySingleton: JournalRepository | null = null

export function getJournalRepository(): JournalRepository {
  if (!repositorySingleton) repositorySingleton = new JournalRepository()
  return repositorySingleton
}

/** 测试钩子。 */
export function resetJournalRepository(): void {
  repositorySingleton = null
}
