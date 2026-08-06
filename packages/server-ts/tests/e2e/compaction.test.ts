import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'
import { getUserContext } from '../../src/modules/chat/user-context.js'
import { ensureSessionCompaction, flushUnextracted, getInFlightCompaction } from '../../src/memory/compaction.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

import { deepseekChat } from '../../src/common/llm.js'

const COMPACTION_JSON = JSON.stringify({
  anchoredSummary: {
    patient: '患者 ZQ 亚急性病程',
    decisions: ['倾向肺部感染'],
    treatment: ['抗感染治疗观察'],
    vitals: [],
    pending: ['复查胸部CT'],
    questions: [],
  },
  facts: [
    { content: '患者 ZQ 发热3周伴胸痛，亚急性病程，倾向肺部感染', category: 'diagnosis', importance: 4, sourceType: 'patient' },
  ],
  episodeUpdate: '- ZQ：发热3周伴胸痛，亚急性病程\n- 倾向肺部感染，抗感染观察，待复查CT',
})

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

function droppedWindow(ctx: ReturnType<typeof getUserContext>, sessionId: string, count: number) {
  const events = ctx.eventLog
    .query({ sessionId })
    .filter((e: any) => e.eventType === 'user_message' || e.eventType === 'assistant_response')
    .sort((a: any, b: any) => a.idx - b.idx)
  const lastCovered = events[count - 1].idx
  return { firstRetainedIdx: events[count].idx, lastCoveredIdx: lastCovered }
}

function seedEvents(userId: string, sessionId: string, turns: number) {
  const base = getUserContext(userId)
  for (let i = 0; i < turns; i++) {
    base.eventLog.append({
      timestamp: Date.now() / 1000, eventType: 'user_message', content: `第${i + 1}轮：患者ZQ发热伴胸痛，体温38.5度，已持续三周`,
      metadata: {}, agentId: userId, sessionId,
    })
    base.eventLog.append({
      timestamp: Date.now() / 1000, eventType: 'assistant_response', content: `第${i + 1}轮回复：考虑感染，建议进一步检查胸部影像学。`,
      metadata: {}, agentId: userId, sessionId,
    })
  }
  return { ...base, userId }
}

describe('R2 anchored compaction', () => {
  test('compacts the dropped segment: anchored summary + facts + episode', async () => {
    const userId = await getAuthUserId()
    const sessionId = `compact_${Date.now()}`
    const ctx = seedEvents(userId, sessionId, 5)
    const dropped = droppedWindow(ctx, sessionId, 4)

    vi.mocked(deepseekChat).mockResolvedValue(COMPACTION_JSON)

    await ensureSessionCompaction(ctx, sessionId, dropped.firstRetainedIdx, undefined)

    // S2: kbCompaction keeps ONLY the cursor (empty summary); the anchored
    // content lives in the Session Memory (episodes).
    const compactions = await (prisma as any).kbCompaction.findMany({
      where: { userId, sessionId },
      orderBy: { coveredUptoIdx: 'desc' },
    })
    expect(compactions.length).toBe(1)
    expect(compactions[0].coveredUptoIdx).toBe(dropped.lastCoveredIdx)
    expect(compactions[0].summary).toBe('')

    // Facts land in the pending review queue
    const proposals = await (prisma as any).memoryProposal.findMany({
      where: { userId, kind: 'fact', status: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
    expect(proposals.some((p: any) => p.content.includes('发热3周'))).toBe(true)

    // Episode summary updated (K3 merge)
    expect(ctx.episodes.all().find(e => e.sessionId === sessionId)?.summary).toContain('ZQ')
  }, 30000)

  test('already-covered segments are not re-compacted', async () => {
    const userId = await getAuthUserId()
    const sessionId = `compact_noop_${Date.now()}`
    const ctx = seedEvents(userId, sessionId, 5)
    const dropped = droppedWindow(ctx, sessionId, 4)

    vi.mocked(deepseekChat).mockResolvedValue(COMPACTION_JSON)

    await ensureSessionCompaction(ctx, sessionId, dropped.firstRetainedIdx, undefined)
    const callsAfterFirst = vi.mocked(deepseekChat).mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    // Same window again → covered check short-circuits, no LLM call
    await ensureSessionCompaction(ctx, sessionId, dropped.firstRetainedIdx, undefined)
    expect(vi.mocked(deepseekChat).mock.calls.length).toBe(callsAfterFirst)

    const compactions = await (prisma as any).kbCompaction.findMany({ where: { userId, sessionId } })
    expect(compactions.length).toBe(1)
    // Session Memory holds the anchored content
    expect(ctx.episodes.all().find(e => e.sessionId === sessionId)?.summary).toContain('ZQ')
  }, 30000)

  test('too-short segments are left for the close flush', async () => {
    const userId = await getAuthUserId()
    const sessionId = `compact_short_${Date.now()}`
    const ctx = seedEvents(userId, sessionId, 1)

    vi.mocked(deepseekChat).mockResolvedValue(COMPACTION_JSON)

    // Window of 2 events (< 4) → no compaction
    await ensureSessionCompaction(ctx, sessionId, 3, undefined)
    expect(vi.mocked(deepseekChat).mock.calls.length).toBe(0)

    const compactions = await (prisma as any).kbCompaction.findMany({ where: { userId, sessionId } })
    expect(compactions.length).toBe(0)
  }, 30000)
})

describe('S2 — no anchored-summary payload in kbCompaction', () => {
  test('compaction updates Session Memory and writes only an empty cursor row', async () => {
    const userId = await getAuthUserId()
    const sessionId = `s2_${Date.now()}`
    const ctx = seedEvents(userId, sessionId, 5)
    const dropped = droppedWindow(ctx, sessionId, 4)

    vi.mocked(deepseekChat).mockResolvedValue(COMPACTION_JSON)

    await ensureSessionCompaction(ctx, sessionId, dropped.firstRetainedIdx, undefined)

    const rows = await (prisma as any).kbCompaction.findMany({ where: { userId, sessionId } })
    expect(rows.length).toBe(1)
    expect(rows[0].summary).toBe('')
    // Episode summary updated (K3 merge) — Session Memory is the single store
    expect(ctx.episodes.all().find(e => e.sessionId === sessionId)?.summary).toContain('ZQ')
    // No anchoredSummary JSON anywhere
    expect(JSON.stringify(rows)).not.toContain('"patient"')
  }, 30000)
})

describe('R2 delayed-sync in-flight query', () => {
  test('getInFlightCompaction reports a running compaction and clears after', async () => {
    const userId = await getAuthUserId()
    const sessionId = `compact_inflight_${Date.now()}`
    const ctx = seedEvents(userId, sessionId, 5)
    const dropped = droppedWindow(ctx, sessionId, 4)

    let resolveLlm: ((v: string) => void) | null = null
    vi.mocked(deepseekChat).mockImplementation(() => new Promise<string>((resolve) => { resolveLlm = resolve }))

    // Start without awaiting (fire-and-forget as in the router)
    const promise = ensureSessionCompaction(ctx, sessionId, dropped.firstRetainedIdx, undefined)

    // Wait for the internal prisma lookups to finish and the LLM call to start
    await new Promise((r) => setTimeout(r, 100))

    // While running → reported as in-flight and awaitable
    expect(resolveLlm).not.toBeNull()
    expect(getInFlightCompaction(userId, sessionId)).not.toBeNull()

    resolveLlm!(COMPACTION_JSON)
    await promise

    // After completion → cleared
    expect(getInFlightCompaction(userId, sessionId)).toBeNull()
    const compactions = await (prisma as any).kbCompaction.findMany({ where: { userId, sessionId } })
    expect(compactions.length).toBe(1)
  }, 30000)
})

describe('Tier 3 session-close flush', () => {
  test('extracts segments not covered by cursor or compaction', async () => {
    const userId = await getAuthUserId()
    const sessionId = `flush_${Date.now()}`
    const ctx = seedEvents(userId, sessionId, 3)

    vi.mocked(deepseekChat).mockResolvedValue('[{"content":"患者ZQ发热3周待复查CT","category":"symptom","importance":4,"sourceType":"patient"}]')

    const flushed = await flushUnextracted(ctx, sessionId, undefined)

    expect(flushed).toBe(1)
    const proposals = await (prisma as any).memoryProposal.findMany({
      where: { userId, kind: 'fact', status: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
    expect(proposals.some((p: any) => p.content.includes('待复查CT'))).toBe(true)
  }, 30000)
})
