import { describe, test, expect } from 'vitest'
import { compactContext, deduplicateFindings, rankByAttention } from '../src/retrieval/context-compressor'
import type { Fact } from '../src/evolution/stores'

describe('P4 — Context Compressor', () => {
  const makeFact = (overrides: Partial<Fact>): Fact => ({
    id: 'f1', category: 'fact', importance: 3, content: 'test', count: 1,
    createdAt: Date.now(), updatedAt: Date.now(), lastSeenAt: Date.now(),
    ...overrides,
  })

  describe('rankByAttention', () => {
    test('higher importance gets higher score', () => {
      const facts = [
        makeFact({ id: 'a', importance: 5, content: 'High importance', lastSeenAt: Date.now() }),
        makeFact({ id: 'b', importance: 1, content: 'Low importance', lastSeenAt: Date.now() }),
      ]
      const ranked = rankByAttention(facts)
      expect(ranked[0].id).toBe('a')
      expect(ranked[1].id).toBe('b')
    })

    test('more recent gets higher score', () => {
      const now = Date.now()
      const facts = [
        makeFact({ id: 'old', importance: 3, lastSeenAt: now - 30 * 86400_000 }), // 30 days ago
        makeFact({ id: 'new', importance: 3, lastSeenAt: now }),
      ]
      const ranked = rankByAttention(facts)
      expect(ranked[0].id).toBe('new')
    })

    test('returns top N', () => {
      const facts = Array.from({ length: 30 }, (_, i) =>
        makeFact({ id: `f${i}`, importance: i + 1, lastSeenAt: Date.now() })
      )
      const ranked = rankByAttention(facts, 10)
      expect(ranked.length).toBe(10)
      expect(ranked[0].importance).toBe(30)
    })
  })

  describe('deduplicateFindings', () => {
    test('merges same entity across time', () => {
      const findings = [
        'RUL nodule 18mm (CT 4/10)',
        'RUL nodule 18mm (CT 7/15)',
        'CEA 3.2 (Lab 7/15)',
        'RUL nodule 18mm (CT 6/01)',
      ]
      const result = deduplicateFindings(findings)
      expect(result).toContain('rul nodule: 18mm (3 entries)')
      expect(result).toContain('CEA 3.2')
      expect(result.length).toBe(2)
    })

    test('handles empty input', () => {
      expect(deduplicateFindings([])).toEqual([])
    })
  })

  describe('compactContext', () => {
    test('compresses Facts to compact representation', () => {
      const facts = [
        makeFact({ id: 'f1', category: 'fact', importance: 4, content: 'RUL nodule 18mm (CT 7/15)', lastSeenAt: Date.now(), count: 3 }),
        makeFact({ id: 'f2', category: 'fact', importance: 3, content: 'CEA 3.2 normal', lastSeenAt: Date.now() }),
      ]
      const result = compactContext(facts, [], [])
      expect(result).toContain('RUL nodule')
      expect(result).toContain('CEA 3.2')
      expect(result.length).toBeLessThan(500) // target compression
    })

    test('preferences get highest priority', () => {
      const facts = [
        makeFact({ id: 'p1', category: 'preference', importance: 5, content: 'Prefer Chinese', lastSeenAt: Date.now(), count: 10 }),
        makeFact({ id: 'f1', category: 'fact', importance: 4, content: 'NSCLC trial active', lastSeenAt: Date.now() }),
      ]
      const result = compactContext(facts, [], [])
      const prefsIndex = result.indexOf('Prefer Chinese')
      const factsIndex = result.indexOf('NSCLC trial')
      expect(prefsIndex).toBeLessThan(factsIndex)
    })
  })
})
