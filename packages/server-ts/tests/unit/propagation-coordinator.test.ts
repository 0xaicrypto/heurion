import { describe, test, expect, vi } from 'vitest'
import { PropagationCoordinator } from '../../src/memory/propagation-coordinator.js'
import { LegacyProjection, type LegacySnapshot } from '../../src/memory/legacy-projection.js'

/**
 * #304: write-order atomicity in isolation — legacy commits are provisional,
 * the graph commits last, and a graph failure rolls the legacy stores back.
 */
describe('PropagationCoordinator (#304)', () => {
  test('graph-commit failure rolls the legacy stores back to the snapshot', () => {
    const legacy = {
      snapshot: vi.fn(() => ({ facts: [{ id: 'f1' }], knowledge: [] }) as LegacySnapshot),
      rollback: vi.fn(),
      reconcile: vi.fn(),
      applyPropagation: vi.fn(),
    } as unknown as LegacyProjection
    const graph = { commit: vi.fn(() => { throw new Error('disk full') }) } as any

    const coordinator = new PropagationCoordinator(legacy, graph)
    const snap = coordinator.begin()
    expect(() => coordinator.commit(snap)).toThrow('disk full')
    expect(legacy.rollback).toHaveBeenCalledWith(snap)
  })

  test('successful commit leaves the legacy stores untouched', () => {
    const legacy = {
      snapshot: vi.fn(() => ({ facts: [], knowledge: [] }) as LegacySnapshot),
      rollback: vi.fn(),
      reconcile: vi.fn(),
      applyPropagation: vi.fn(),
    } as unknown as LegacyProjection
    const graph = { commit: vi.fn() } as any

    const coordinator = new PropagationCoordinator(legacy, graph)
    const snap = coordinator.begin()
    coordinator.commit(snap)
    expect(graph.commit).toHaveBeenCalledTimes(1)
    expect(legacy.rollback).not.toHaveBeenCalled()
  })
})
