import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * #1009 — 对话中建议：K6 反向判定 + 语义命中 + 去重/忽略 + 接受/丢弃。
 */
const db = vi.hoisted(() => ({
  sessionRefs: [] as any[],
  suggestions: [] as any[],
  items: [] as any[],
  usage: vi.fn(),
  tier: vi.fn(),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    sessionReference: {
      findMany: vi.fn(async ({ where }: any) => db.sessionRefs.filter((r) => r.userId === where.userId && r.sessionId === where.sessionId)),
      findUnique: vi.fn(async ({ where }: any) => db.sessionRefs.find((r) => r.id === where.id) ?? null),
      create: vi.fn(async ({ data }: any) => { db.sessionRefs.push(data); return data }),
    },
    suggestedReference: {
      findMany: vi.fn(async ({ where }: any) => db.suggestions.filter((r) => r.userId === where.userId && r.sessionId === where.sessionId && (where.status?.in ? where.status.in.includes(r.status) : true))),
      findFirst: vi.fn(async ({ where }: any) => db.suggestions.find((r) => r.id === where.id && r.userId === where.userId && r.sessionId === where.sessionId) ?? null),
      create: vi.fn(async ({ data }: any) => { const row = { id: `sug_${db.suggestions.length + 1}`, ...data }; db.suggestions.push(row); return row }),
      update: vi.fn(async ({ where, data }: any) => { const row = db.suggestions.find((r) => r.id === where.id); Object.assign(row, data); return row }),
    },
    referenceItem: {
      findUnique: vi.fn(async ({ where }: any) => db.items.find((r) => r.id === where.id) ?? null),
      findMany: vi.fn(async () => db.items),
      create: vi.fn(async ({ data }: any) => { db.items.push(data); return data }),
    },
    memoryUsageEvent: { create: db.usage },
    memoryTierEvent: { create: db.tier },
  },
}))

import { detectSuggestedReference, resolveSuggestedReference } from '../../src/modules/shared/suggested-reference.service.js'
import { indexReferenceItem } from '../../src/memory/reference-embedding.js'

const fakeEmbed = (texts: string[]) => Promise.resolve(texts.map((t) => [t.includes('EGFR') ? 1 : 0, 0.2]))

describe('#1009 suggested reference', () => {
  const tmpDir = path.join(os.tmpdir(), `heurion-suggest-${Date.now()}`)
  beforeEach(async () => {
    process.env.TWIN_BASE_DIR = tmpDir
    fs.mkdirSync(path.join(tmpDir, 'u1'), { recursive: true })
    db.sessionRefs = []
    db.suggestions = []
    db.items = [{ id: 'ref_egfr', userId: 'u1', kind: 'pasted_text', sourceRef: null, label: 'EGFR 材料', snapshot: 'EGFR 突变治疗策略' }]
    db.usage.mockReset().mockResolvedValue({})
    db.tier.mockReset().mockImplementation(async ({ data }: any) => ({ id: 'evt', ...data }))
    await indexReferenceItem({ id: 'ref_egfr', userId: 'u1', kind: 'pasted_text', snapshot: 'EGFR 突变治疗策略', label: 'EGFR 材料' }, { embedFn: fakeEmbed })
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.TWIN_BASE_DIR
  })

  test('问题形消息 + 语义命中未引用材料 → 生成 pending 建议 + usage suggested', async () => {
    const res = await detectSuggestedReference({ userId: 'u1', sessionId: 'sess_1', message: 'EGFR 突变患者应该如何选择一线治疗？', embedFn: fakeEmbed })
    expect(res).toMatchObject({ referenceId: 'ref_egfr' })
    expect(db.suggestions).toHaveLength(1)
    expect(db.suggestions[0].reason).toBe('对话内容命中未引用材料')
    expect(db.usage).toHaveBeenCalledWith({ data: expect.objectContaining({ unitType: 'reference', unitId: 'ref_egfr', action: 'suggested' }) })
  })

  test('非问题形消息 / 短消息 → 不触发（K6 反向判定复用）', async () => {
    expect(await detectSuggestedReference({ userId: 'u1', sessionId: 'sess_1', message: 'EGFR 材料', embedFn: fakeEmbed })).toBeNull()
    expect(await detectSuggestedReference({ userId: 'u1', sessionId: 'sess_1', message: 'EGFR？', embedFn: fakeEmbed })).toBeNull()
  })

  test('已挂载/已忽略的材料不重复建议', async () => {
    db.sessionRefs = [{ id: 'sr1', userId: 'u1', sessionId: 'sess_1', referenceId: 'ref_egfr' }]
    expect(await detectSuggestedReference({ userId: 'u1', sessionId: 'sess_1', message: 'EGFR 突变怎么治疗？', embedFn: fakeEmbed })).toBeNull()

    db.sessionRefs = []
    db.suggestions = [{ id: 'sug_old', userId: 'u1', sessionId: 'sess_1', referenceId: 'ref_egfr', status: 'dismissed' }]
    expect(await detectSuggestedReference({ userId: 'u1', sessionId: 'sess_1', message: 'EGFR 突变怎么治疗？', embedFn: fakeEmbed })).toBeNull()
  })

  test('接受 → 正式引用(suggestion_accepted) + usage accepted + 层级留痕', async () => {
    const det = await detectSuggestedReference({ userId: 'u1', sessionId: 'sess_1', message: 'EGFR 突变怎么治疗？', embedFn: fakeEmbed })
    const res = await resolveSuggestedReference('u1', 'sess_1', det!.suggestionId, true)
    expect(res.ok).toBe(true)
    expect(db.suggestions[0].status).toBe('accepted')
    expect(db.sessionRefs.some((r) => r.source === 'suggestion_accepted')).toBe(true)
    expect(db.usage).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'accepted' }) })
    expect(db.tier).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'promote', unitId: 'ref_egfr' }) })
  })

  test('忽略 → 只置 dismissed（不产生正式引用）', async () => {
    const det = await detectSuggestedReference({ userId: 'u1', sessionId: 'sess_1', message: 'EGFR 突变怎么治疗？', embedFn: fakeEmbed })
    await resolveSuggestedReference('u1', 'sess_1', det!.suggestionId, false)
    expect(db.suggestions[0].status).toBe('dismissed')
    expect(db.sessionRefs).toHaveLength(0)
    expect(db.usage).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'dismissed' }) })
  })
})
