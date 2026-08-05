import { describe, test, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { EventLog } from '../src/core/event-log.js'
import { FactsStore, KnowledgeStore } from '../src/evolution/stores.js'
import { MemoryService } from '../src/memory/memory.service.js'
import { sanitizeFactFields, FACT_CONTENT_MAX } from '../src/memory/memory.types.js'

/**
 * §4.2 (#187): uncertain flag + whitelist validation + length bounds.
 */
describe('fact field sanitization (§4.2 #187)', () => {
  test('low confidence auto-marks uncertain', () => {
    expect(sanitizeFactFields({ content: 'x', confidence: 0.5 }).uncertain).toBe(true)
    expect(sanitizeFactFields({ content: 'x', confidence: 0.6 }).uncertain).toBe(false)
    expect(sanitizeFactFields({ content: 'x', confidence: 0.9 }).uncertain).toBe(false)
  })

  test('explicit uncertain wins when no confidence is given', () => {
    expect(sanitizeFactFields({ content: 'x', uncertain: true }).uncertain).toBe(true)
    expect(sanitizeFactFields({ content: 'x' }).uncertain).toBe(false)
  })

  test('category and sourceType fall back to whitelist defaults', () => {
    const clean = sanitizeFactFields({ content: 'x', category: 'bogus' as any, sourceType: 'nope' as any })
    expect(clean.category).toBe('fact')
    expect(clean.sourceType).toBe('general')
    expect(sanitizeFactFields({ content: 'x', category: 'goal', sourceType: 'doctor' }).category).toBe('goal')
  })

  test('content is bounded to FACT_CONTENT_MAX', () => {
    const long = 'a'.repeat(FACT_CONTENT_MAX + 500)
    const clean = sanitizeFactFields({ content: long })
    expect(clean.content.length).toBe(FACT_CONTENT_MAX)
  })
})

describe('MemoryService fact writes enforce §4.2 (#187)', () => {
  let baseDir: string
  let memory: MemoryService

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uncertain-'))
    memory = new MemoryService({
      eventLog: new EventLog(baseDir, 'u1'),
      baseDir,
      legacyFacts: new FactsStore(baseDir),
      legacyKnowledge: new KnowledgeStore(baseDir),
      ownerId: 'u1',
    })
  })

  test('addFact stores uncertain and sanitizes fields', () => {
    const f = memory.addFact({
      content: 'x'.repeat(FACT_CONTENT_MAX + 100),
      category: 'bogus' as any,
      sourceType: 'nope' as any,
      confidence: 0.4,
    }, 'system') as any
    expect(f.uncertain).toBe(true)
    expect(f.content.length).toBe(FACT_CONTENT_MAX)
    expect(f.category).toBe('fact')
    expect(f.sourceType).toBe('general')
  })

  test('high-confidence facts are not uncertain', () => {
    const f = memory.addFact({ content: '确认无误', confidence: 0.95 }, 'system') as any
    expect(f.uncertain).toBe(false)
  })
})
