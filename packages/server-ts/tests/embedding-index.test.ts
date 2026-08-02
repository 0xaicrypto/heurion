import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { EmbeddingIndex, cosineSimilarity } from '../src/memory/embedding-index.js'

function makeBaseDir() {
  const dir = path.join(os.tmpdir(), `emb-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const vec = (seed: number, dim = 8): number[] => {
  const out: number[] = []
  for (let i = 0; i < dim; i++) out.push(Math.sin(seed * (i + 1)) + 1)
  return out
}

beforeEach(() => {})
afterEach(() => {})

describe('EmbeddingIndex', () => {
  test('upsert persists and reloads records', () => {
    const base = makeBaseDir()
    const idx = new EmbeddingIndex(base)
    idx.upsert({
      nodeId: 'n1@v1', stableId: 'n1', type: 'fact', patientHash: 'p1',
      contentHash: 'abc', vector: vec(1), model: 'bge-m3', norm: 1, updatedAt: Date.now(),
    })
    expect(idx.count()).toBe(1)

    const reloaded = new EmbeddingIndex(base)
    expect(reloaded.count()).toBe(1)
    expect(reloaded.all()[0].stableId).toBe('n1')
  })

  test('search ranks by cosine similarity with patient isolation', () => {
    const base = makeBaseDir()
    const idx = new EmbeddingIndex(base)
    idx.upsert({ nodeId: 'a@v1', stableId: 'a', type: 'fact', patientHash: 'p1', contentHash: 'x', vector: vec(1), model: 'm', norm: 1, updatedAt: 0 })
    idx.upsert({ nodeId: 'b@v1', stableId: 'b', type: 'fact', patientHash: 'p1', contentHash: 'y', vector: vec(1.1), model: 'm', norm: 1, updatedAt: 0 })
    idx.upsert({ nodeId: 'c@v1', stableId: 'c', type: 'fact', patientHash: 'p2', contentHash: 'z', vector: vec(5), model: 'm', norm: 1, updatedAt: 0 })

    const hits = idx.search(vec(1.05), { patientHash: 'p1', topK: 5, minScore: 0 })
    // Only p1 records
    expect(hits.every((h) => h.record.patientHash === 'p1')).toBe(true)
    expect(hits.length).toBe(2)

    // Cross-patient included only when requested
    const all = idx.search(vec(1.05), { patientHash: 'p1', includeCrossPatient: true, topK: 5, minScore: 0 })
    expect(all.length).toBe(3)
  })

  test('findMostSimilar returns the top hit for semantic dedup', () => {
    const base = makeBaseDir()
    const idx = new EmbeddingIndex(base)
    idx.upsert({ nodeId: 'a@v1', stableId: 'a', type: 'fact', patientHash: 'p1', contentHash: 'x', vector: vec(1), model: 'm', norm: 1, updatedAt: 0 })
    const hit = idx.findMostSimilar(vec(1.01), { patientHash: 'p1' })
    expect(hit?.record.stableId).toBe('a')
    expect(hit!.score).toBeGreaterThan(0.99)
  })

  test('remove deletes the record', () => {
    const base = makeBaseDir()
    const idx = new EmbeddingIndex(base)
    idx.upsert({ nodeId: 'a@v1', stableId: 'a', type: 'fact', contentHash: 'x', vector: vec(1), model: 'm', norm: 1, updatedAt: 0 })
    idx.remove('a', 'fact')
    expect(idx.count()).toBe(0)
  })
})

describe('cosineSimilarity', () => {
  test('identical vectors → 1, orthogonal → 0, opposite → -1', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1)
  })

  test('mismatched lengths → 0', () => {
    expect(cosineSimilarity([1, 0], [1])).toBe(0)
  })
})
