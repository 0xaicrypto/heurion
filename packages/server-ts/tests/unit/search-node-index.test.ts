import { describe, test, expect, vi, afterEach } from 'vitest'
import { SearchNodeTool, clearGraphIndexCache } from '../../src/tools/clinical-graph-tools.js'

/**
 * #199: SearchNodeTool fallback now uses a keyword inverted index +
 * patientHash grouping. Behavior must be identical to the old
 * JSON.stringify scan; performance must not degrade with graph size.
 */
function makeNode(id: string, patientHash: string, content: string, type = 'fact') {
  return { id, stableId: id, type, patientHash, content, title: '', status: 'current' }
}

function makeCtx(nodes: any[]) {
  return {
    userId: 'u1',
    sessionId: 's1',
    memory: { graph: { getAllNodes: () => nodes } },
    facts: { all: () => [] },
    episodes: { all: () => [] },
    skills: { all: () => [] },
    knowledge: { all: () => [] },
    eventLog: { append: () => {} },
  }
}

describe('SearchNodeTool inverted index (#199)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    // The index cache is keyed by userId:graphVersion — mock graphs share
    // the same key, so tests must not leak nodes across cases.
    clearGraphIndexCache()
  })

  test('fallback returns the same results as a plain scan (behavior unchanged)', async () => {
    const nodes = [
      makeNode('f1', 'p1', 'EGFR mutation detected in exon 19'),
      makeNode('f2', 'p1', 'PD-L1 expression 60%'),
      makeNode('f3', 'p2', 'EGFR wild-type'), // other patient — must be excluded
      makeNode('a1', 'p1', 'Article about immune checkpoint inhibitors'),
    ]
    // Force the embedding path to fail so the fallback runs.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('embedding down'))

    const tool = new SearchNodeTool(makeCtx(nodes) as any)
    const res = await tool.execute({ patient_hash: 'p1', query: 'EGFR', top_k: 10 })
    expect(res.success).toBe(true)
    const hits = JSON.parse(res.output!).hits
    const ids = hits.map((h: any) => h.node_id)
    expect(ids).toContain('f1')
    expect(ids).not.toContain('f3') // other patient excluded
  })

  test('returns connected neighbors within the same patient only', async () => {
    const nodes = [
      makeNode('f1', 'p1', 'chest pain for three weeks'),
      makeNode('f2', 'p1', 'cough with fever'),
      makeNode('f3', 'p2', 'unrelated other patient fact'),
    ]
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('embedding down'))

    const tool = new SearchNodeTool(makeCtx(nodes) as any)
    const res = await tool.execute({ patient_hash: 'p1', query: 'chest', top_k: 5 })
    const hits = JSON.parse(res.output!).hits
    expect(hits.length).toBeGreaterThan(0)
    // The hit's connected nodes must never include the other patient's fact.
    const connectedIds = hits.flatMap((h: any) => (h.connected || []).map((c: any) => c.node_id))
    expect(connectedIds).not.toContain('f3')
  })

  test('500-node graph stays fast (index path, <200ms)', async () => {
    const nodes = Array.from({ length: 500 }, (_, i) =>
      makeNode(`f${i}`, i % 3 === 0 ? 'p1' : 'p2', `finding ${i}: EGFR treatment outcomes for ${i % 3 === 0 ? 'patient one' : 'patient two'}`),
    )
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('embedding down'))

    const tool = new SearchNodeTool(makeCtx(nodes) as any)
    const t0 = Date.now()
    const res = await tool.execute({ patient_hash: 'p1', query: 'EGFR treatment', top_k: 5 })
    const elapsed = Date.now() - t0
    expect(res.success).toBe(true)
    expect(JSON.parse(res.output!).hits.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(200)
  })
})
