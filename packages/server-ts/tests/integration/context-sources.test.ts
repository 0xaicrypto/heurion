import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { EventLog } from '../../src/core/event-log.js'
import { MemoryProjection } from '../../src/retrieval/memory-projection.js'
import { computeSegments, loadSnapshot, saveSnapshot, hashText } from '../../src/memory/context-sources.js'

/**
 * R1 (#98): typed context sources — stable segments keep byte-identical
 * hashes across turns (prompt-cache friendly); changes are diffable.
 */
describe('R1 context sources (#98)', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-src-'))
    process.env.TWIN_BASE_DIR = baseDir
  })

  afterEach(() => {
    delete process.env.TWIN_BASE_DIR
  })

  test('stable segments keep their hash; changed segments are diffed', () => {
    const prev = computeSegments('u1', [
      { key: 'persona', text: '稳定 persona' },
      { key: 'facts', text: '事实 A' },
    ], null).state
    saveSnapshot('u1', prev)

    // Second turn: persona unchanged, facts changed.
    const { state, diff } = computeSegments('u1', [
      { key: 'persona', text: '稳定 persona' },
      { key: 'facts', text: '事实 A + 新事实 B' },
    ], loadSnapshot('u1'))

    expect(diff.changed).toEqual(['facts'])
    expect(diff.removed).toEqual([])
    expect(state.persona.hash).toBe(prev.persona.hash)
    expect(state.facts.hash).toBe(hashText('事实 A + 新事实 B'))
  })

  test('removed sources are reported in the diff', () => {
    const prev = computeSegments('u1', [
      { key: 'persona', text: 'p' },
      { key: 'doc', text: 'd' },
    ], null).state
    saveSnapshot('u1', prev)

    const { diff } = computeSegments('u1', [{ key: 'persona', text: 'p' }], loadSnapshot('u1'))
    expect(diff.removed).toEqual(['doc'])
    expect(diff.changed).toEqual([])
  })

  test('projection emits per-layer segments', async () => {
    const projection = new MemoryProjection(new EventLog(baseDir, 'u1'))
    const res = await projection.project({
      userId: 'u1', patientHash: null, sessionId: 's1',
      persona: 'persona',
      facts: [], episodes: [], skills: [],
    })
    const keys = res.segments.map((s) => s.key)
    expect(keys).toContain('persona')
    // Empty session → no conversation segment, but the key space is typed.
    expect(keys).not.toContain('recent_conversation')
    expect(res.systemPrompt).toContain('persona')
  })
})
