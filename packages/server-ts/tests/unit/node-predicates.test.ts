import { describe, test, expect } from 'vitest'
import { isNodeSuperseded, isNodeStale, isFactCurrent, isSummaryStale, type FactNode, type SummaryNode } from '../../src/memory/memory.types.js'

function base(over: Partial<FactNode> = {}): FactNode {
  return {
    id: 'fact_x@v1', stableId: 'fact_x', type: 'fact', ownerId: 'u1', status: 'current',
    content: 'c', contentHash: 'h', version: 1, createdAt: 1, updatedAt: 1, createdBy: 'system',
    provenance: { sourceKind: 'chat' }, meta: {}, category: 'fact', sourceType: 'general', count: 1, confidence: 0.8,
    ...over,
  }
}

function summary(over: Partial<SummaryNode> = {}): SummaryNode {
  return {
    id: 'art_x@v1', stableId: 'art_x', type: 'summary', ownerId: 'u1', status: 'current',
    content: 'c', contentHash: 'h', version: 1, createdAt: 1, updatedAt: 1, createdBy: 'system',
    provenance: { sourceKind: 'chat' }, meta: {}, title: 't', sourceFacts: [{ nodeId: 'f@v1', stableId: 'fact_a', version: 1, snapshot: 's' }],
    ...over,
  }
}

describe('node behavior predicates (#305)', () => {
  test('isNodeSuperseded / isNodeStale read the status', () => {
    expect(isNodeSuperseded(base())).toBe(false)
    expect(isNodeSuperseded(base({ status: 'superseded' }))).toBe(true)
    expect(isNodeSuperseded(null)).toBe(false)
    expect(isNodeStale(base({ status: 'stale' }))).toBe(true)
  })

  test('isFactCurrent requires current status and a count', () => {
    expect(isFactCurrent(base())).toBe(true)
    expect(isFactCurrent(base({ count: 0 }))).toBe(false)
    expect(isFactCurrent(base({ status: 'superseded' }))).toBe(false)
  })

  test('isSummaryStale flags summaries whose source facts were superseded', () => {
    expect(isSummaryStale(summary(), ['other'])).toBe(false)
    expect(isSummaryStale(summary(), ['fact_a'])).toBe(true)
    expect(isSummaryStale(summary({ status: 'superseded' }), [])).toBe(true)
  })
})
