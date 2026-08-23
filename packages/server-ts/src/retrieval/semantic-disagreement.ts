/**
 * #585 — shadow-mode disagreement statistics (pure functions).
 *
 * While INTENT_SEMANTIC_ROUTER=shadow, the semantic probe is recorded
 * (sidecarDetail.semantic) WITHOUT deciding. This module turns the collected
 * records into the gate metrics required before flipping to 'on':
 *   - disagreement rate < 5% (semantic decided but the LLM disagreed)
 *   - generate recall >= 0.9 (LLM-confirmed generate that semantic missed)
 *   - semantic classify latency p50 < 50ms
 *
 * 分歧定义 (保守 — 宁可回落 LLM,不可误放行):
 *   - semantic=generate 但 LLM 裁决非 generate → 分歧 (on 模式下会误放行)
 *   - semantic=veto 但 LLM 裁决 generate → 分歧 (on 模式下会误杀真请求)
 *   - 其余 (LLM uncertain/discuss vs semantic 任意) → 一致 (LLM 更保守,
 *     回落路径在 on 模式下本来就存在)
 */
export type ShadowRecord = {
  semantic: 'generate' | 'veto' | 'uncertain'
  llmVerdict: 'generate' | 'discuss' | 'uncertain' | 'vetoed'
  semanticMs?: number
}

export interface DisagreementReport {
  total: number
  /** 语义层做出明确判定 (generate/veto) 且走了 LLM 兜底的记录数。 */
  semanticDecided: number
  /** 分歧数 (见上方定义)。 */
  disagreements: number
  /** 分歧率 = disagreements / semanticDecided。 */
  disagreementRate: number
  /** generate recall: semantic 判 generate 中 LLM 也确认 generate 的比例。 */
  generateRecall: number
  semanticGenerate: number
  llmConfirmedGenerate: number
  /** 高置信路径 (on 模式零 LLM 可直通) 的语义判定延迟。 */
  latency: { p50: number; p95: number; n: number }
  gates: { disagreementPass: boolean; recallPass: boolean; latencyPass: boolean }
}

const DISAGREEMENT_GATE_RATE = 0.05
const GENERATE_RECALL_GATE = 0.9
const LATENCY_P50_GATE_MS = 50

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

export function computeDisagreementReport(records: ShadowRecord[]): DisagreementReport {
  const total = records.length
  const decided = records.filter((r) => r.semantic === 'generate' || r.semantic === 'veto')
  const disagreements = decided.filter((r) =>
    (r.semantic === 'generate' && r.llmVerdict !== 'generate')
    || (r.semantic === 'veto' && r.llmVerdict === 'generate'),
  ).length
  const semanticGenerate = decided.filter((r) => r.semantic === 'generate').length
  const llmConfirmedGenerate = decided.filter((r) => r.semantic === 'generate' && r.llmVerdict === 'generate').length
  const latencies = records
    .filter((r) => typeof r.semanticMs === 'number' && r.semantic !== 'uncertain')
    .map((r) => r.semanticMs as number)
    .sort((a, b) => a - b)
  return {
    total,
    semanticDecided: decided.length,
    disagreements,
    disagreementRate: decided.length > 0 ? disagreements / decided.length : 0,
    generateRecall: semanticGenerate > 0 ? llmConfirmedGenerate / semanticGenerate : 0,
    semanticGenerate,
    llmConfirmedGenerate,
    latency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), n: latencies.length },
    gates: {
      disagreementPass: decided.length === 0 || disagreements / decided.length < DISAGREEMENT_GATE_RATE,
      recallPass: llmConfirmedGenerate / Math.max(semanticGenerate, 1) >= GENERATE_RECALL_GATE,
      latencyPass: percentile(latencies, 50) < LATENCY_P50_GATE_MS,
    },
  }
}

/** Render the report as a human-readable monthly summary (eval script / cron). */
export function renderDisagreementReport(rep: DisagreementReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`
  return [
    `#585 shadow semantic-router monthly report`,
    `records: ${rep.total} (semantic decided: ${rep.semanticDecided})`,
    `disagreement rate: ${pct(rep.disagreementRate)} (${rep.disagreements}/${rep.semanticDecided}) [gate < 5%: ${rep.gates.disagreementPass ? 'PASS' : 'FAIL'}]`,
    `generate recall: ${pct(rep.generateRecall)} (${rep.llmConfirmedGenerate}/${rep.semanticGenerate}) [gate >= 90%: ${rep.gates.recallPass ? 'PASS' : 'FAIL'}]`,
    `semantic latency: p50=${rep.latency.p50}ms p95=${rep.latency.p95}ms (n=${rep.latency.n}) [gate p50 < 50ms: ${rep.gates.latencyPass ? 'PASS' : 'FAIL'}]`,
    `flip to on: ${rep.gates.disagreementPass && rep.gates.recallPass && rep.gates.latencyPass ? 'READY' : 'NOT READY'}`,
  ].join('\n')
}
