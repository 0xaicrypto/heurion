import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

import { deepseekChat } from '../../src/common/llm.js'
import { synthesizeExperience } from '../../src/modules/skills/experience-synthesis.service.js'
import prisma from '../../src/common/prisma'
import { getApp, authHeader } from '../setup.js'

/**
 * #24: experience synthesis — multiple confirmed facts → grouped LLM
 * candidates persisted as pending_review skills.
 */
describe('experience synthesis (#24)', () => {
  beforeEach(() => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  test('groups confirmed facts by category and persists candidates with provenance', async () => {
    // LLM returns a valid candidate JSON.
    vi.mocked(deepseekChat).mockResolvedValue(
      JSON.stringify({ name: 'EGFR-TKI 耐药后处理', description: '对 EGFR 突变 NSCLC 患者', steps: ['评估耐药机制', '复查活检'], prompt: '模板' }),
    )

    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }
    const userId = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/user/profile', headers: await authHeader() })).payload).user_id

    // Seed 4 facts in one category via memory import (importance >= 3).
    const imp = await app.inject({
      method: 'POST', url: '/api/v1/memory/import', headers,
      payload: JSON.stringify({
        facts: [
          { category: 'fact', importance: 4, content: '患者对 TKI 耐药后复查活检确认 T790M', sourceType: 'patient' },
          { category: 'fact', importance: 4, content: 'T790M 阳性改用三代 TKI', sourceType: 'doctor' },
          { category: 'fact', importance: 4, content: '三代 TKI 对 T790M 有效', sourceType: 'research' },
          { category: 'medication', importance: 5, content: '心衰患者利尿剂使用', sourceType: 'patient' },
        ],
      }),
    })
    expect(imp.statusCode).toBe(200)

    const result = await synthesizeExperience(userId, { minFacts: 3 })
    // Only the oncology group has >= 3 facts → 1 group.
    expect(result.groups).toBe(1)
    expect(result.candidates.length).toBe(1)
    expect(result.candidates[0].name).toContain('EGFR')
    expect(result.candidates[0].sourceCount).toBe(3)
    expect(result.candidates[0].sources.length).toBe(3)

    // Persisted with provenance in sourceSession + pending_review status.
    const rows = await (prisma as any).capturedSkill.findMany({
      where: { userId, status: 'pending_review' },
    })
    expect(rows.length).toBe(1)
    const meta = JSON.parse(rows[0].sourceSession)
    expect(meta.kind).toBe('experience-synthesis')
    expect(meta.category).toBe('fact')
    expect(meta.sources.length).toBe(3)
  }, 30000)

  test('thin graphs produce no candidates (minFacts gate)', async () => {
    vi.mocked(deepseekChat).mockResolvedValue('{}')
    const app = await getApp()
    // Fresh user — getToken() caches the shared test token.
    const username = `thin_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const reg = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username, password: 'test123456', display_name: 'Thin Test' }),
    })
    const regBody = JSON.parse(reg.payload)
    const headers = { authorization: `Bearer ${regBody.jwt_token}`, 'content-type': 'application/json' }
    const userId = regBody.user_id

    const imp = await app.inject({
      method: 'POST', url: '/api/v1/memory/import', headers,
      payload: JSON.stringify({ facts: [{ category: 'fact', importance: 3, content: '单条', sourceType: 'patient' }] }),
    })
    expect(imp.statusCode).toBe(200)

    const result = await synthesizeExperience(userId, { minFacts: 3 })
    expect(result.groups).toBe(0)
    expect(result.candidates.length).toBe(0)
    // No LLM call for an empty group.
    expect(deepseekChat).not.toHaveBeenCalled()
  }, 30000)

  test('manual API endpoint runs synthesis', async () => {
    vi.mocked(deepseekChat).mockResolvedValue(
      JSON.stringify({ name: 'x', description: 'd', steps: ['s'], prompt: 'p' }),
    )
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }
    const res = await app.inject({
      method: 'POST', url: '/api/v1/skills/synthesize', headers,
      payload: JSON.stringify({}),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(typeof body.groups).toBe('number')
    expect(Array.isArray(body.candidates)).toBe(true)
  }, 30000)
})
