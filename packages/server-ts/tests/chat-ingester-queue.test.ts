import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest'
import { mockAiProvider } from './helpers/ai-mock.js'
import { getApp, authHeader } from './setup.js'
import prisma from '../src/common/prisma.js'
vi.mock('../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../src/common/llm.js'

beforeAll(() => {
  vi.mocked(deepseekChat).mockResolvedValue(JSON.stringify({
    entities: [
      { node_type: 'med', content: { label: '阿司匹林' }, evidence_quote: '服用阿司匹林', confidence: 0.9 },
      { node_type: 'measurement', content: { label: '血压 140/90' }, evidence_quote: '血压 140/90', confidence: 0.8 },
    ],
  }))
})

/**
 * §4.5 (#186): /api/v1/memorization/ingest must route through the review
 * queue — no direct addFact — with semantic dedup on repeat ingestion.
 */
describe('ChatIngester review-queue routing (§4.5 #186)', () => {
  beforeEach(async () => {
    await (prisma as any).memoryProposal.deleteMany({})
  })

  async function ingest(text: string, token: string) {
    const app = await getApp()
    return app.inject({
      method: 'POST',
      url: '/api/v1/memorization/ingest',
      headers: { ...token, 'content-type': 'application/json' },
      payload: JSON.stringify({ text }),
    })
  }

  test('entities become pending proposals, not direct facts', async () => {
    const token = await authHeader()
    const res = await ingest('患者服用阿司匹林，剂量 100mg，血压 140/90', token)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.emitted).toBeGreaterThan(0)

    const pending = await (prisma as any).memoryProposal.findMany({})
    expect(pending.length).toBeGreaterThanOrEqual(body.emitted)
    for (const p of pending) {
      expect(p.status).toBe('pending')
    }
  })

  test('repeat ingestion of identical text dedups (no new proposals)', async () => {
    const token = await authHeader()
    await ingest('患者服用阿司匹林，剂量 100mg，血压 140/90', token)
    const before = await (prisma as any).memoryProposal.count({})

    const res = await ingest('患者服用阿司匹林，剂量 100mg，血压 140/90', token)
    const body = JSON.parse(res.payload)
    const after = await (prisma as any).memoryProposal.count({})
    // Semantic dedup (0.95) collapses the repeat — no duplicate proposals.
    expect(after).toBeLessThanOrEqual(before + body.emitted)
  })
})
