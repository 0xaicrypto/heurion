import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader } from '../setup.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

import { deepseekChat } from '../../src/common/llm.js'

/**
 * #12: research-progress summary — aggregates protocol/enrollment/rules/
 * safety/assessments and returns an AI-generated journal-ready paragraph.
 */
describe('research summary (#12)', () => {
  beforeEach(() => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  test('summary endpoint aggregates study facts and returns AI paragraph', async () => {
    vi.mocked(deepseekChat).mockImplementation((messages: any) => {
      if (JSON.stringify(messages).includes('临床研究协调员')) {
        return Promise.resolve('本阶段共入组 2 例患者，已确认 1/3 条研究规则，未触发停止规则。')
      }
      return Promise.resolve('mixed\n')
    })
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }

    const study = await app.inject({
      method: 'POST', url: '/api/v1/research/studies', headers,
      payload: JSON.stringify({ display_name: 'NSCLC 免疫研究', short_code: 'NSCLC01' }),
    })
    const studyId = JSON.parse(study.payload).study_id

    // Enroll 2 patients so roster has arms.
    for (const ph of ['pat-a', 'pat-b']) {
      await app.inject({
        method: 'POST', url: `/api/v1/research/studies/${studyId}/enrollments`, headers,
        payload: JSON.stringify({ patient_hash: ph, arm: 'Arm A' }),
      })
    }

    const res = await app.inject({
      method: 'GET', url: `/api/v1/research/studies/${studyId}/summary`, headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.study_id).toBe(studyId)
    expect(body.facts.some((f: string) => f.includes('NSCLC01'))).toBe(true)
    expect(body.facts.some((f: string) => f.includes('入组：2'))).toBe(true)
    expect(body.summary).toContain('入组 2 例')
    expect(body.generated_at).toBeDefined()
  }, 30000)

  test('summary falls back to structured facts when LLM is unavailable', async () => {
    vi.mocked(deepseekChat).mockRejectedValue(new Error('llm down'))
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }

    const study = await app.inject({
      method: 'POST', url: '/api/v1/research/studies', headers,
      payload: JSON.stringify({ display_name: 'Test Study', short_code: 'T01' }),
    })
    const studyId = JSON.parse(study.payload).study_id

    const res = await app.inject({
      method: 'GET', url: `/api/v1/research/studies/${studyId}/summary`, headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    // summary = structured facts joined (non-empty fallback).
    expect(body.summary.length).toBeGreaterThan(0)
    expect(body.facts.length).toBeGreaterThan(0)
  }, 30000)
})
