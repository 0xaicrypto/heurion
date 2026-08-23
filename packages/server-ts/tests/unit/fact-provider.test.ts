import { describe, test, expect } from 'vitest'
import { ContextBudget } from '../../src/modules/chat/chat-context.js'
import { LegacyFactProvider } from '../../src/memory/fact-provider.js'
import { FactsStore } from '../../src/evolution/stores.js'
import { factContentHash } from '../../src/common/fact-render.js'

describe('#637 ContextBudget 抽象', () => {
  test('剩余预算 = maxTotal − system − history', () => {
    const b = new ContextBudget(64000, 32000)
    b.allocateSystem(15000)
    b.allocateHistory(12000)
    expect(b.remaining()).toBe(64000 - 15000 - 12000)
  })

  test('三档分档:rich >30% / mid >10% / tight', () => {
    const rich = new ContextBudget(64000, 32000)
    rich.allocateSystem(10000); rich.allocateHistory(10000) // remaining 44K = 68%
    expect(rich.tier()).toBe('rich')

    const mid = new ContextBudget(64000, 32000)
    mid.allocateSystem(40000); mid.allocateHistory(10000) // remaining 14K = 22%
    expect(mid.tier()).toBe('mid')

    const tight = new ContextBudget(64000, 32000)
    tight.allocateSystem(50000); tight.allocateHistory(10000) // remaining 4K = 6%
    expect(tight.tier()).toBe('tight')
  })

  test('systemCap = maxTotal − history;usage 视图完整', () => {
    const b = new ContextBudget(64000, 32000)
    b.allocateSystem(15000)
    b.allocateHistory(20000)
    expect(b.systemCap()).toBe(44000)
    expect(b.usage()).toEqual({
      system_tokens: 15000,
      history_tokens: 20000,
      system_budget: 44000,
      remaining: 29000,
    })
  })
})

describe('#637 FactProvider 适配器(legacy)', () => {
  test('listCurrent 返回 ScoredFact + 跨 store 去重 key', () => {
    const facts = new FactsStore('/tmp/fp-test-legacy')
    const f = facts.add({ content: 'EGFR 突变', category: 'fact', importance: 4, sourceType: 'patient', patientHash: 'p1' })
    facts.add({ content: '偏好中文回复', category: 'preference', importance: 3, sourceType: 'doctor' })
    facts.commit()

    const provider = new LegacyFactProvider(facts)
    const all = provider.listCurrent()
    expect(all).toHaveLength(2)
    expect(all[0]).toMatchObject({ content: 'EGFR 突变', category: 'fact', importance: 4, source: `fact:${f.id}` })
    expect(all[0].factHash).toBe(factContentHash({ content: 'EGFR 突变', category: 'fact', patientHash: 'p1' }))

    const onlyP1 = provider.listCurrent({ patientHash: 'p1' })
    expect(onlyP1).toHaveLength(1)
    expect(onlyP1[0].content).toBe('EGFR 突变')
  })
})
