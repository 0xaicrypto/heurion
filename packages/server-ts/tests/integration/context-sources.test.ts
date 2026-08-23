import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { MemoryProjection } from '../../src/retrieval/memory-projection.js'
import { computeSegments, loadSnapshot, saveSnapshot, hashText, renderSystemPromptFiltered } from '../../src/memory/context-sources.js'

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
    const projection = new MemoryProjection()
    const res = await projection.project({
      userId: 'u1', patientHash: null,
      persona: 'persona',
      facts: [], episodes: [], skills: [],
    })
    const keys = res.segments.map((s) => s.key)
    expect(keys).toContain('persona')
    // #634: layer1 removed — recent conversation never appears in segments.
    expect(keys).not.toContain('recent_conversation')
    expect(res.systemPrompt).toContain('persona')
  })

  test('#634: projection no longer injects recent conversation (layer1 removed)', async () => {
    const projection = new MemoryProjection()
    const res = await projection.project({
      userId: 'u1', patientHash: null,
      persona: 'persona',
      facts: [], episodes: [], skills: [],
    })
    expect(res.systemPrompt).not.toContain('Recent Conversation')
    expect(res.budget.map((b) => b.layer)).not.toContain('layer1_recent')
  })

  test('#635: filtered render drops whole segments, keeps base', () => {
    const state = computeSegments('u1', [
      { key: 'persona', text: 'P' },
      { key: 'study_context', text: 'S' },
      { key: 'knowledge_inject', text: 'K' },
      { key: 'picked_kb', text: 'X' },
    ], null).state
    const rendered = renderSystemPromptFiltered('base', state, ['knowledge_inject'])
    expect(rendered).toContain('base')
    expect(rendered).toContain('P')
    expect(rendered).toContain('S')
    expect(rendered).not.toContain('K')
    expect(rendered).toContain('X')
  })
})
