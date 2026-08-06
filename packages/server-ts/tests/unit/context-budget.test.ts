import { describe, test, expect } from 'vitest'
import { enforceTotalBudget, selectProjectionInputs } from '../../src/modules/chat/chat.router.js'
import { estimateTokens } from '../../src/common/token-estimate.js'

/**
 * §3.4 (#194): total context budget.
 */

function makeMessages(count: number, content = 'x'.repeat(200)) {
  const msgs: Array<{ role: string; content: string }> = [{ role: 'system', content: 'SYS' }]
  for (let i = 0; i < count; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `${i}: ${content}` })
  }
  return msgs
}

describe('enforceTotalBudget (§3.4 #194)', () => {
  test('no trimming when under budget', () => {
    const msgs = makeMessages(2, 'short')
    const trimmed = enforceTotalBudget(msgs, 10000)
    expect(trimmed).toBe(0)
    expect(msgs.length).toBe(3)
  })

  test('trims oldest non-system messages first', () => {
    const msgs = makeMessages(10, 'x'.repeat(1000))
    const trimmed = enforceTotalBudget(msgs, 1000)
    expect(trimmed).toBeGreaterThan(0)
    expect(msgs.length).toBe(10 - trimmed + 1)
    // System prompt and the newest user turn survive.
    expect(msgs[0].content).toBe('SYS')
    expect(msgs[msgs.length - 1].content.startsWith('9:')).toBe(true)
  })

  test('truncates the system prompt as a last resort', () => {
    const msgs = [{ role: 'system', content: 'Y'.repeat(10000) }]
    const trimmed = enforceTotalBudget(msgs, 500)
    expect(trimmed).toBe(0)
    expect(msgs[0].content.length).toBeLessThan(10000)
    expect(estimateTokens(JSON.stringify(msgs))).toBeLessThanOrEqual(800)
  })

  test('zero budget is a no-op', () => {
    const msgs = makeMessages(3)
    expect(enforceTotalBudget(msgs, 0)).toBe(0)
    expect(msgs.length).toBe(4)
  })
})

describe('facts hard cap (§3.4 #194)', () => {
  test('projection keeps at most 50 facts', () => {
    const facts = Array.from({ length: 120 }, (_, i) => ({
      id: `f${i}`, content: `fact ${i}`, category: 'fact', importance: 3,
      patientHash: undefined, createdAt: Date.now(), updatedAt: Date.now(), lastSeenAt: Date.now(),
    }))
    const ctx = {
      facts: { all: () => facts },
      episodes: { all: () => [] },
      skills: { all: () => [] },
    } as any
    const mixed = selectProjectionInputs({ intent: 'mixed' } as any, ctx)
    expect(mixed.facts.length).toBeLessThanOrEqual(50)
    const vector = selectProjectionInputs({ intent: 'vector' } as any, ctx)
    expect(vector.facts.length).toBeLessThanOrEqual(50)
    const sql = selectProjectionInputs({ intent: 'sql' } as any, ctx)
    expect(sql.facts.length).toBe(0)
  })
})
