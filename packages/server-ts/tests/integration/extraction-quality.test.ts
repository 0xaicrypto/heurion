import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'
import { getUserContext } from '../../src/modules/chat/user-context.js'
import { MemoryGraphGateway } from '../../src/memory/memory-gateway.js'
import { getCategoryQuality, buildQualityGuidance } from '../../src/memory/extraction-quality.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', 'test-key') })
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('13.4F extraction quality feedback', () => {
  test('propose persists the category', async () => {
    const userId = await getAuthUserId()
    const ctx = getUserContext(userId)
    const gateway = new MemoryGraphGateway(userId, ctx.memory, ctx.facts, ctx.episodes, ctx.skills, ctx.knowledge)
    await gateway.propose({
      scopeType: 'global', kind: 'fact', content: '患者血压偏高', importance: 3,
      confidence: 'medium', reason: 'test', category: 'symptom',
    })
    const row = await (prisma as any).memoryProposal.findFirst({
      where: { userId, content: '患者血压偏高' },
    })
    expect(row.category).toBe('symptom')
  }, 30000)

  test('quality stats compute acceptance rate per category', async () => {
    const userId = await getAuthUserId()
    const now = new Date().toISOString()
    const mk = (category: string, status: string) =>
      (prisma as any).memoryProposal.create({
        data: {
          userId, scopeType: 'global', kind: 'fact', content: `q ${category} ${Math.random()}`,
          importance: 3, confidence: 'medium', category, status,
          createdAt: now, resolvedAt: now,
        },
      })
    await mk('diagnosis', 'approved')
    await mk('diagnosis', 'rejected')
    await mk('diagnosis', 'rejected')
    await mk('medication', 'approved')
    await mk('medication', 'approved')

    const quality = await getCategoryQuality(userId)
    const diag = quality.find(q => q.category === 'diagnosis')
    const med = quality.find(q => q.category === 'medication')
    expect(diag?.rate).toBeCloseTo(1 / 3)
    expect(med?.rate).toBe(1)
  }, 30000)

  test('low acceptance rate produces stricter guidance', () => {
    const guidance = buildQualityGuidance([
      { category: 'diagnosis', accepted: 1, rejected: 5, rate: 1 / 6 },
      { category: 'medication', accepted: 9, rejected: 1, rate: 0.9 },
    ])
    expect(guidance).toContain('diagnosis')
    expect(guidance).toContain('更严格')
  })

  test('no stats → no guidance', () => {
    expect(buildQualityGuidance([])).toBe('')
  })
})
