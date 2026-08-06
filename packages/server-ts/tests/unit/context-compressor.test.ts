import { describe, test, expect } from 'vitest'
import { compactContext, deduplicateFindings, rankByAttention, buildHistoryMessages } from '../../src/retrieval/context-compressor'
import type { Fact } from '../../src/evolution/stores'

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
    test('merges same entity across time and keeps every value (§4.4 #195)', () => {
      const findings = [
        'RUL nodule 18mm (CT 4/10)',
        'RUL nodule 18mm (CT 7/15)',
        'CEA 3.2 (Lab 7/15)',
        'RUL nodule 18mm (CT 6/01)',
      ]
      const result = deduplicateFindings(findings)
      expect(result.length).toBe(2)
      const rul = result.find(r => r.toLowerCase().includes('rul nodule'))
      expect(rul).toBeDefined()
      // Trend preserved: all three values are chained, not just the first.
      expect(rul!.match(/18mm/g)).toHaveLength(3)
      expect(rul!.includes('3 entries')).toBe(true)
      expect(result.some(r => r.includes('CEA'))).toBe(true)
    })

    test('trend values chain distinct readings (BP example §4.4)', () => {
      const result = deduplicateFindings([
        'BP 140/90 (门诊 8/1)',
        'BP 120/80 (门诊 8/5)',
      ])
      expect(result[0]).toContain('140/90')
      expect(result[0]).toContain('120/80')
      expect(result[0]).toContain('→')
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

describe('buildHistoryMessages — token-budgeted history', () => {
  const events = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      eventType: i % 2 === 0 ? 'user_message' : 'assistant_response',
      content: i % 2 === 0 ? `用户提问 ${i}` : `回答内容 ${i}`,
    }))

  test('keeps everything when under budget', () => {
    const { messages, omittedTurns, tokens } = buildHistoryMessages(events(10), { maxTokens: 5000 })
    expect(messages.length).toBe(10)
    expect(omittedTurns).toBe(0)
    expect(tokens).toBeGreaterThan(0)
    // Newest first
    expect(messages[0].content).toContain('9')
  })

  test('trims oldest turns when over budget', () => {
    // ~20 turns of long content; small budget forces trimming
    const long = events(40).map((e) => ({ ...e, content: e.content + '（这是一段很长的临床讨论内容，用于撑大 token 预算，重复填充以便测试裁剪逻辑是否按预期工作）' }))
    const { messages, omittedTurns, tokens } = buildHistoryMessages(long, { maxTokens: 600, maxTurns: 20 })
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.length).toBeLessThan(40)
    expect(omittedTurns).toBeGreaterThan(0)
    expect(tokens).toBeLessThanOrEqual(600 + 200) // tolerance for the first oversized msg
    // Newest (last event) is still included
    expect(messages[0].content).toContain('39')
  })

  test('respects maxTurns cap', () => {
    const { messages } = buildHistoryMessages(events(40), { maxTokens: 100_000, maxTurns: 3 })
    expect(messages.length).toBe(6) // 3 turns × 2 events
  })

  test('includes a single oversized message whole', () => {
    const big = '长'.repeat(10_000)
    const { messages, tokens } = buildHistoryMessages(
      [{ eventType: 'user_message', content: big }],
      { maxTokens: 100 },
    )
    expect(messages.length).toBe(1)
    expect(messages[0].content).toBe(big)
    expect(tokens).toBeGreaterThan(100)
  })

  test('empty events produce empty result', () => {
    const { messages, omittedTurns } = buildHistoryMessages([])
    expect(messages).toEqual([])
    expect(omittedTurns).toBe(0)
  })
})
