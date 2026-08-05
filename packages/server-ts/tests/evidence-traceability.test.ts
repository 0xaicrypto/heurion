import { describe, test, expect } from 'vitest'
import { MemoryProjection } from '../src/retrieval/memory-projection.js'
import { EventLog } from '../src/core/event-log.js'
import type { Fact } from '../src/evolution/stores'

/**
 * §4.3 (#188): clinical evidence is traceable — confidence and source
 * survive from write → projection → prompt.
 */
function makeFact(overrides: Partial<Fact>): Fact {
  return {
    id: 'f1', category: 'fact', importance: 3, content: 'test', count: 1,
    createdAt: Date.now(), updatedAt: Date.now(), lastSeenAt: Date.now(),
    ...overrides,
  }
}

function project(facts: Fact[]) {
  const projection = new MemoryProjection(new EventLog('/tmp/nonexistent-proj', 'u1'))
  return projection.project({
    userId: 'u1',
    patientHash: null,
    sessionId: 's1',
    persona: 'persona',
    facts,
    episodes: [],
    skills: [],
  })
}

describe('clinical evidence traceability (§4.3 #188)', () => {
  test('facts with provenance surface confidence + source in the prompt', async () => {
    const { systemPrompt } = await project([
      makeFact({
        id: 'f1', content: '患者服用阿司匹林',
        confidence: 0.9,
        provenance: { sourceKind: 'chat', sourceRef: 'enc-1', evidenceQuote: '每日服用阿司匹林' },
      }),
    ])
    expect(systemPrompt).toContain('[0.9')
    expect(systemPrompt).toContain('source: chat')
    expect(systemPrompt).toContain('患者服用阿司匹林')
  })

  test('facts without evidence omit the annotation', async () => {
    const { systemPrompt } = await project([
      makeFact({ id: 'f1', content: '普通事实' }),
    ])
    expect(systemPrompt).toContain('普通事实')
    expect(systemPrompt).not.toContain('conf ')
  })

  test('citation rule is injected when facts are present', async () => {
    const { systemPrompt } = await project([
      makeFact({ id: 'f1', content: '某记忆', confidence: 0.8, provenance: { sourceKind: 'doctor' } }),
    ])
    expect(systemPrompt).toContain('引用记忆中的事实时')
    expect(systemPrompt).toContain('[置信度, 来源]')
  })
})
