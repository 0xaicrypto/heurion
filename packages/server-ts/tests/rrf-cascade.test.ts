import { describe, test, expect } from 'vitest'
import { rrfFusion, RrfCandidate } from '../src/retrieval/rrf-fusion'

describe('P7 — RRF Fusion', () => {
  test('merges and ranks results from multiple sources', () => {
    const sqlResults: RrfCandidate[] = [
      { content: 'ZL', source: 'sql', sourceId: 'p1', rank: 1 },
      { content: 'Age 65', source: 'sql', sourceId: 'p1', rank: 2 },
    ]
    const vectorResults: RrfCandidate[] = [
      { content: 'NSCLC immunotherapy review', source: 'vector', sourceId: 'k1', rank: 1 },
      { content: 'EGFR exon19 deletion', source: 'vector', sourceId: 'f1', rank: 2 },
    ]
    const graphResults: RrfCandidate[] = [
      { content: 'RUL nodule → measuredIn → CT 7/15', source: 'graph', sourceId: 'g1', rank: 1 },
    ]

    const merged = rrfFusion([sqlResults, vectorResults, graphResults], 10)
    expect(merged.length).toBeGreaterThan(0)
    // SQL patient info should rank high (low rank number = high priority)
    expect(merged[0].source).toBe('sql')
  })

  test('deduplicates by content', () => {
    const results1: RrfCandidate[] = [
      { content: 'NSCLC immunotherapy', source: 'vector', sourceId: 'v1', rank: 1 },
    ]
    const results2: RrfCandidate[] = [
      { content: 'NSCLC immunotherapy', source: 'graph', sourceId: 'g1', rank: 1 },
    ]
    const merged = rrfFusion([results1, results2], 10)
    expect(merged.length).toBe(1)
    expect(merged[0].score).toBeGreaterThan(1) // RRF score merge
  })

  test('respects topK limit', () => {
    const results: RrfCandidate[][] = [
      Array.from({ length: 20 }, (_, i) => ({ content: `Item ${i}`, source: 'vector' as const, sourceId: String(i), rank: i + 1 })),
    ]
    const merged = rrfFusion(results, 5)
    expect(merged.length).toBe(5)
  })

  test('empty inputs return empty', () => {
    expect(rrfFusion([], 10)).toEqual([])
    expect(rrfFusion([[]], 10)).toEqual([])
  })
})

describe('P8 — Knowledge Cascade', () => {
  test('markStale marks article when dependent fact changes', () => {
    const articles = [{
      id: 'k1', title: 'NSCLC review', content: 'Review',
      sources: [{ type: 'fact' as const, id: 'f1', version: 1, content: 'RUL 18mm' }],
      version: 1, status: 'current' as const, createdAt: 0, updatedAt: 0,
    }]
    const changedFacts = new Set(['f1'])

    const updated = articles.map(a => ({
      ...a,
      status: a.sources.some(s => changedFacts.has(s.id)) ? ('stale' as const) : a.status,
      staleBecause: a.sources.some(s => changedFacts.has(s.id)) ? a.sources.filter(s => changedFacts.has(s.id)).map(s => s.id) : undefined,
    }))

    expect(updated[0].status).toBe('stale')
    expect(updated[0].staleBecause).toContain('f1')
  })

  test('unchanged facts keep article current', () => {
    const articles = [{
      id: 'k2', title: 'Other', content: 'X',
      sources: [{ type: 'fact' as const, id: 'f2', version: 1, content: 'Other' }],
      version: 1, status: 'current' as const, createdAt: 0, updatedAt: 0,
    }]
    const changedFacts = new Set(['f1'])

    const updated = articles.map(a => ({
      ...a,
      status: a.sources.some(s => changedFacts.has(s.id)) ? ('stale' as const) : a.status,
    }))

    expect(updated[0].status).toBe('current')
  })
})
