import { describe, test, expect } from 'vitest'
import { MemoryGraphGateway, registerProposalApplier } from '../../src/memory/memory-gateway.js'

// Character-bucket pseudo-embedding: overlapping characters (e.g. 过敏)
// produce similar vectors, so cosine reflects semantic overlap.
function fakeEmbed(texts: string[]): number[][] {
  return texts.map((t) => {
    const v = new Array(16).fill(0)
    for (const ch of t) {
      const bucket = ch.charCodeAt(0) % 16
      v[bucket] += 1
    }
    return v
  })
}

function makeGateway(userId: string) {
  return new MemoryGraphGateway(userId, null as any, null as any, null as any, null as any, null as any, fakeEmbed)
}

describe('gateway semantic retrieval + dedup', () => {
  test('propose dedups content too similar to a reviewed fact', async () => {
    const uid = `user_dedup_${Date.now()}`
    const gw = makeGateway(uid)

    // First proposal (no reviewed facts yet) → pending
    const first = await gw.propose({ scopeType: 'patient', patientHash: 'p1', kind: 'fact', content: '患者对青霉素过敏' })
    expect(first.status).toBe('pending')

    // Apply it (writes graph via applier + embedding index)
    const applier = (u: string, p: any) => (u === uid ? { id: `n_${p.id}`, stableId: `s_${p.id}`, contentHash: p.content.slice(0, 16), patientHash: p.patientHash, content: p.content } as any : null)
    registerProposalApplier(applier)
    await gw.applyApproved(first)

    // Identical-content proposal → semantically duplicate → auto-rejected
    const dup = await gw.propose({ scopeType: 'patient', patientHash: 'p1', kind: 'fact', content: '患者对青霉素过敏' })
    expect(dup.status).toBe('rejected')
    expect(dup.rejectedReason).toContain('语义重复')

    // Unrelated content → pending
    const ok = await gw.propose({ scopeType: 'patient', patientHash: 'p1', kind: 'fact', content: 'WBC 11.2 偏高' })
    expect(ok.status).toBe('pending')
  })

  test('retrieve returns semantically related reviewed facts within scope', async () => {
    const uid = `user_retr_${Date.now()}`
    const gw = makeGateway(uid)

    const f1 = await gw.propose({ scopeType: 'patient', patientHash: 'p1', kind: 'fact', content: '患者对磺胺类药物过敏，出现皮疹' })
    const f2 = await gw.propose({ scopeType: 'patient', patientHash: 'p2', kind: 'fact', content: '肿瘤标志物 CEA 升高' })
    registerProposalApplier((u: string, p: any) => (u === uid ? { id: `n_${p.id}`, stableId: `s_${p.id}`, contentHash: p.content.slice(0, 16), patientHash: p.patientHash, content: p.content } as any : null))
    const node1 = await gw.applyApproved(f1)
    await gw.applyApproved(f2)
    expect(node1).not.toBeNull()

    // Query about allergies → p1's fact (same scope, semantic match)
    const hits = await gw.retrieve('有没有药物过敏史', { patientHash: 'p1' }, { topK: 5, minScore: 0 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].stableId).toBe(node1!.stableId)
    // p2's fact must not leak into p1 scope
    expect(hits.some((h) => h.stableId === `s_${f2.id}`)).toBe(false)
  }, 30000)
})
