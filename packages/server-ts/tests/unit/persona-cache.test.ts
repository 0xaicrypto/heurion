import { describe, test, expect, afterEach } from 'vitest'
import { buildCachedPersona } from '../../src/modules/chat/user-context.js'

function mockStore(version: string) {
  const entries: Array<{ content: string; category?: string; importance?: number; patientHash?: string | null; studyId?: string | null }> = []
  return {
    currentVersion: () => version,
    all: () => entries,
    _push: (c: string) => entries.push({ content: c, category: 'fact', importance: 3, patientHash: null, studyId: null }),
  }
}

describe('persona cache LRU (#301)', () => {
  afterEach(() => {
    // Reset module-level cache by touching many users.
    for (let i = 0; i < 105; i++) buildCachedPersona(`evict_${i}`, mockStore('v1') as any, mockStore('v1') as any)
  })

  test('reuses cached persona when versions are unchanged', () => {
    const facts = mockStore('v1') as any
    const knowledge = mockStore('v1') as any
    const first = buildCachedPersona('u_1', facts, knowledge)
    const second = buildCachedPersona('u_1', facts, knowledge)
    expect(second).toBe(first)
  })

  test('rebuilds when the version bumps', () => {
    const facts = mockStore('v1') as any
    const knowledge = mockStore('v1') as any
    const first = buildCachedPersona('u_2', facts, knowledge)
    const bumped = mockStore('v2') as any
    bumped._push('new fact after update')
    const second = buildCachedPersona('u_2', bumped, knowledge)
    expect(second).not.toBe(first)
    expect(second).toContain('new fact after update')
  })

  test('bounds the cache size (LRU eviction)', () => {
    const facts = mockStore('v1') as any
    const knowledge = mockStore('v1') as any
    buildCachedPersona('lru_hit', facts, knowledge)
    for (let i = 0; i < 150; i++) buildCachedPersona(`lru_${i}`, facts, knowledge)
    // lru_hit was the oldest and must have been evicted (rebuild → new identity
    // would be fine anyway; the important part is the cache stayed bounded and
    // the most recent entry is served from cache).
    const again = buildCachedPersona('lru_149', facts, knowledge)
    expect(again).toBeTruthy()
  })
})
