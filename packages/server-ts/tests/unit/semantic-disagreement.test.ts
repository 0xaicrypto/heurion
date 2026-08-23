import { describe, test, expect } from 'vitest'
import { computeDisagreementReport, percentile, type ShadowRecord } from '../../src/retrieval/semantic-disagreement.js'

describe('#585 semantic shadow disagreement report', () => {
  test('空记录 → 全零指标,门槛视为未达(gates false 除分歧外保守)', () => {
    const rep = computeDisagreementReport([])
    expect(rep.total).toBe(0)
    expect(rep.semanticDecided).toBe(0)
    expect(rep.disagreementRate).toBe(0)
    expect(rep.latency.n).toBe(0)
  })

  test('semantic=generate 且 LLM 也 generate → 一致,分歧为 0', () => {
    const records: ShadowRecord[] = [
      { semantic: 'generate', llmVerdict: 'generate' },
      { semantic: 'generate', llmVerdict: 'generate' },
      { semantic: 'veto', llmVerdict: 'discuss' },
    ]
    const rep = computeDisagreementReport(records)
    expect(rep.semanticDecided).toBe(3)
    expect(rep.disagreements).toBe(0)
    expect(rep.disagreementRate).toBe(0)
    expect(rep.generateRecall).toBe(1)
    expect(rep.gates.disagreementPass).toBe(true)
    expect(rep.gates.recallPass).toBe(true)
  })

  test('semantic=generate 但 LLM 否 → 分歧(on 模式会误放行),分歧率超门槛', () => {
    const records: ShadowRecord[] = [
      { semantic: 'generate', llmVerdict: 'discuss' },
      { semantic: 'generate', llmVerdict: 'discuss' },
    ]
    const rep = computeDisagreementReport(records)
    expect(rep.disagreements).toBe(2)
    expect(rep.disagreementRate).toBe(1)
    expect(rep.gates.disagreementPass).toBe(false)
    expect(rep.gates.recallPass).toBe(false)
  })

  test('semantic=veto 但 LLM 判 generate → 分歧(on 模式会误杀真请求)', () => {
    const records: ShadowRecord[] = [
      { semantic: 'veto', llmVerdict: 'generate' },
    ]
    const rep = computeDisagreementReport(records)
    expect(rep.disagreements).toBe(1)
    expect(rep.gates.disagreementPass).toBe(false)
  })

  test('generate recall 门槛: 语义漏召回时 FAIL', () => {
    const records: ShadowRecord[] = [
      { semantic: 'generate', llmVerdict: 'generate' },
      { semantic: 'generate', llmVerdict: 'uncertain' },
      { semantic: 'generate', llmVerdict: 'uncertain' },
      { semantic: 'generate', llmVerdict: 'uncertain' },
      { semantic: 'generate', llmVerdict: 'uncertain' },
      { semantic: 'generate', llmVerdict: 'uncertain' },
      { semantic: 'generate', llmVerdict: 'uncertain' },
      { semantic: 'generate', llmVerdict: 'uncertain' },
      { semantic: 'generate', llmVerdict: 'uncertain' },
    ]
    const rep = computeDisagreementReport(records)
    expect(rep.generateRecall).toBeCloseTo(1 / 9)
    expect(rep.gates.recallPass).toBe(false)
  })

  test('延迟 p50/p95: 50ms 门槛', () => {
    const records: ShadowRecord[] = [
      { semantic: 'generate', llmVerdict: 'generate', semanticMs: 30 },
      { semantic: 'generate', llmVerdict: 'generate', semanticMs: 40 },
      { semantic: 'generate', llmVerdict: 'generate', semanticMs: 45 },
    ]
    const rep = computeDisagreementReport(records)
    expect(rep.latency.n).toBe(3)
    expect(rep.latency.p50).toBe(40)
    expect(rep.gates.latencyPass).toBe(true)
    const slow: ShadowRecord[] = [
      { semantic: 'veto', llmVerdict: 'discuss', semanticMs: 80 },
      { semantic: 'veto', llmVerdict: 'discuss', semanticMs: 120 },
      { semantic: 'veto', llmVerdict: 'discuss', semanticMs: 200 },
    ]
    expect(computeDisagreementReport(slow).gates.latencyPass).toBe(false)
  })

  test('uncertain 探测不参与分歧与延迟统计', () => {
    const records: ShadowRecord[] = [
      { semantic: 'uncertain', llmVerdict: 'discuss' },
      { semantic: 'uncertain', llmVerdict: 'generate' },
      { semantic: 'uncertain', llmVerdict: 'discuss', semanticMs: 5 },
    ]
    const rep = computeDisagreementReport(records)
    expect(rep.semanticDecided).toBe(0)
    expect(rep.disagreements).toBe(0)
    expect(rep.latency.n).toBe(0)
  })

  test('percentile 边界', () => {
    expect(percentile([], 50)).toBe(0)
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30)
    expect(percentile([10, 20, 30, 40, 50], 95)).toBe(50)
  })
})
