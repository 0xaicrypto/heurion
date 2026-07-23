import { describe, test, expect } from 'vitest'
import { semanticSearch, SearchResult } from '../src/retrieval/semantic-search'

describe('P6 — Semantic Search', () => {
  const corpus = [
    'NSCLC immunotherapy with pembrolizumab shows 60% response rate in PD-L1 > 50% patients',
    'Osimertinib 80mg daily is standard first-line for EGFR exon19 deletion',
    'Patient ZL has persistent cough for 3 weeks, recommend CT scan',
    'CEA tumor marker normal range is < 5 ng/mL',
    'RUL nodule 18mm stable on CT compared to prior scan 3 months ago',
  ]

  test('returns relevant results for immunotherapy query', () => {
    const results = semanticSearch('immunotherapy for lung cancer', corpus)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].content).toContain('immunotherapy')
  })

  test('returns empty for no matches', () => {
    const results = semanticSearch('xyznonexistent', corpus)
    expect(results.length).toBe(0)
  })

  test('ranks exact matches higher', () => {
    const results = semanticSearch('CEA', corpus)
    expect(results[0].content).toContain('CEA')
  })

  test('respects topK limit', () => {
    const results = semanticSearch('patient', corpus, 2)
    expect(results.length).toBe(2)
  })
})
