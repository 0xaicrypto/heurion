import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'
import { getUserContext } from '../../src/modules/chat/user-context.js'
import { MemoryGraphGateway } from '../../src/memory/memory-gateway.js'
import type { FactNode } from '../../src/memory/memory.types'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', 'test-key') })
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

function buildGateway(userId: string, patientHash?: string) {
  const ctx = getUserContext(userId)
  return {
    ctx,
    gateway: new MemoryGraphGateway(userId, ctx.memory, ctx.facts, ctx.episodes, ctx.skills, ctx.knowledge),
  }
}

describe('§5.7 conflict detection & supersede', () => {
  test('approving a proposal with same-scope conflictsWith supersedes the old fact', async () => {
    const userId = await getAuthUserId()
    const patientHash = `patient_cf_${Date.now()}`
    const { ctx, gateway } = buildGateway(userId, patientHash)

    // Old confirmed fact: allergy
    const oldFact = ctx.memory.addFact(
      {
        content: '患者对青霉素过敏，禁忌使用',
        category: 'allergy',
        importance: 5,
        patientHash,
        sourceType: 'patient',
      },
      'system',
    ) as FactNode

    // New contradictory proposal for the SAME patient
    const row = await gateway.propose({
      scopeType: 'patient',
      patientHash,
      kind: 'fact',
      content: '患者可用青霉素（既往过敏记录有误）',
      importance: 5,
      confidence: 'medium',
      reason: 'test',
      conflictsWith: [{ stableId: oldFact.stableId, content: oldFact.content }],
    })
    expect(row.status).toBe('pending')
    expect(row.conflictsWith).toBeTruthy()

    // Human approves → old fact superseded, new fact current
    const node = await gateway.applyApproved(row)
    expect(node).toBeTruthy()

    const oldLatest = ctx.memory.graph.getLatestByStableId(oldFact.stableId) as FactNode
    expect(oldLatest.status).toBe('superseded')

    const currentFacts = ctx.memory.graph.getCurrentNodesByType('fact') as FactNode[]
    expect(currentFacts.some(f => f.content.includes('可用青霉素'))).toBe(true)
    expect(currentFacts.some(f => f.content.includes('禁忌使用'))).toBe(false)
  }, 30000)

  test('cross-scope conflict markers are dropped (facts are not isolated)', async () => {
    const userId = await getAuthUserId()
    const patientA = `patient_ca_${Date.now()}`
    const patientB = `patient_cb_${Date.now()}`
    const { ctx, gateway } = buildGateway(userId, patientB)

    // Patient A's allergy fact
    const aFact = ctx.memory.addFact(
      { content: '患者A对青霉素过敏', category: 'allergy', importance: 5, patientHash: patientA, sourceType: 'patient' },
      'system',
    ) as FactNode

    // Patient B's conversation produces a conflicting statement — the marker
    // references patient A's fact → must be dropped at propose time
    const row = await gateway.propose({
      scopeType: 'patient',
      patientHash: patientB,
      kind: 'fact',
      content: '患者B可用青霉素',
      importance: 5,
      confidence: 'medium',
      reason: 'test',
      conflictsWith: [{ stableId: aFact.stableId, content: aFact.content }],
    })
    expect(row.status).toBe('pending')
    expect(row.conflictsWith).toBeNull()

    // Approving must NOT touch patient A's fact
    await gateway.applyApproved(row)
    const aLatest = ctx.memory.graph.getLatestByStableId(aFact.stableId) as FactNode
    expect(aLatest.status).toBe('current')
  }, 30000)

  test('extraction pipeline carries conflictsWith into the pending queue', async () => {
    const userId = await getAuthUserId()
    const patientHash = `patient_ce_${Date.now()}`
    const { ctx, gateway } = buildGateway(userId, patientHash)
    const sessionId = `cf_seg_${Date.now()}`

    const oldFact = ctx.memory.addFact(
      { content: '患者对青霉素过敏', category: 'allergy', importance: 5, patientHash, sourceType: 'patient' },
      'system',
    ) as FactNode

    // LLM returns a fact WITH a same-scope conflict marker
    const { deepseekChat } = await import('../../src/common/llm.js')
    vi.mocked(deepseekChat).mockResolvedValue(
      `[{"content":"患者可用青霉素（既往过敏记录有误）","category":"allergy","importance":5,"sourceType":"patient","conflictsWith":["${oldFact.stableId}"]}]`,
    )

    const { extractAndProposeFacts } = await import('../../src/memory/compaction/index.js')
    const extracted = await extractAndProposeFacts({ ...ctx, userId }, patientHash, 'USER: 患者其实可用青霉素，之前记错了\nAI: 已了解', {
      sessionId,
      reason: 'test conflict',
    })
    expect(extracted.length).toBe(1)
    expect(extracted[0].conflictsWith).toEqual([oldFact.stableId])

    // The marker survives into the DB row (only because it is same-scope)
    const rows = await (prisma as any).memoryProposal.findMany({
      where: { userId, kind: 'fact', status: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: 3,
    })
    const marked = rows.find((r: any) => r.content.includes('可用青霉素'))
    expect(marked).toBeTruthy()
    const parsed = JSON.parse(marked.conflictsWith)
    expect(parsed[0].stableId).toBe(oldFact.stableId)
  }, 30000)
})
