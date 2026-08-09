import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader } from '../setup.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

/**
 * #383: research ↔ paper linkage — create paper from study, generate
 * methods from protocol rules, inject statistics results.
 */
describe('research ↔ paper linkage (#383)', () => {
  async function createStudyWithRules(app: any, h: any) {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/research/studies',
      headers: h, payload: JSON.stringify({ display_name: 'NSCLC Immunotherapy Study', short_code: 'NSC001' }),
    })
    const sid = JSON.parse(res.payload).study_id
    await app.inject({
      method: 'POST', url: `/api/v1/research/studies/${sid}/import-protocol`,
      headers: h, payload: JSON.stringify({ text: 'INCLUSION: Stage IIIB/IV NSCLC, PD-L1>=1%\nEXCLUSION: EGFR positive\nSCHEDULE: Cycle 1 Day 1: CBC' }),
    })
    vi.mocked(deepseekChat).mockResolvedValue('{"inclusion":["Stage IIIB/IV NSCLC"],"exclusion":["EGFR positive"],"schedule":[{"visit":"Cycle 1","timing":"Day 1","assessments":["CBC"]}]}')
    await app.inject({
      method: 'POST', url: `/api/v1/research/studies/${sid}/extract-rules`,
      headers: h, payload: JSON.stringify({ text: 'INCLUSION: Stage IIIB/IV NSCLC, PD-L1>=1%\nEXCLUSION: EGFR positive' }),
    })
    return sid
  }

  test('create paper linked to a study', async () => {
    const app = await getApp()
    const h = { ...await authHeader(), 'content-type': 'application/json' }
    const sid = await createStudyWithRules(app, h)

    const res = await app.inject({
      method: 'POST', url: `/api/v1/research/studies/${sid}/paper`,
      headers: h, payload: JSON.stringify({}),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.doc_id).toBeTruthy()
    expect(body.title).toContain('NSCLC Immunotherapy Study')

    const doc = await app.inject({ method: 'GET', url: `/api/v1/docs/${body.doc_id}`, headers: await authHeader() })
    const d = JSON.parse(doc.payload)
    expect(d.study_id).toBe(sid)
    expect(d.study_name).toContain('NSCLC')
  })

  test('generate-methods drafts the Methods section from protocol rules', async () => {
    const app = await getApp()
    const h = { ...await authHeader(), 'content-type': 'application/json' }
    const sid = await createStudyWithRules(app, h)
    const created = await app.inject({
      method: 'POST', url: `/api/v1/research/studies/${sid}/paper`,
      headers: h, payload: JSON.stringify({}),
    })
    const docId = JSON.parse(created.payload).doc_id

    vi.mocked(deepseekChat).mockResolvedValue('This retrospective study enrolled patients with Stage IIIB/IV NSCLC. Statistical analysis used Kaplan-Meier methods.')
    const res = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/generate-methods`,
      headers: h, payload: JSON.stringify({}),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).methods).toContain('Kaplan-Meier')

    // Unlinked doc → 400
    const plain = await app.inject({ method: 'POST', url: '/api/v1/docs', headers: h, payload: JSON.stringify({ title: 'Solo paper' }) })
    const plainId = JSON.parse(plain.payload).id
    const bad = await app.inject({ method: 'POST', url: `/api/v1/docs/${plainId}/generate-methods`, headers: h, payload: JSON.stringify({}) })
    expect(bad.statusCode).toBe(400)
  })

  test('inject-results appends a statistics block to the paper', async () => {
    const app = await getApp()
    const h = { ...await authHeader(), 'content-type': 'application/json' }
    const sid = await createStudyWithRules(app, h)
    const created = await app.inject({
      method: 'POST', url: `/api/v1/research/studies/${sid}/paper`,
      headers: h, payload: JSON.stringify({}),
    })
    const docId = JSON.parse(created.payload).doc_id

    const res = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/inject-results`,
      headers: h,
      payload: JSON.stringify({ label: 'Overall survival', result: '{"method":"kaplan_meier_logrank","p_value":0.012,"median_survival_a":18.6}' }),
    })
    expect(res.statusCode).toBe(200)

    const doc = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}`, headers: await authHeader() })
    expect(JSON.parse(doc.payload).body).toContain('## Overall survival')
    expect(JSON.parse(doc.payload).body).toContain('kaplan_meier_logrank')

    // Missing label → 400
    const bad = await app.inject({ method: 'POST', url: `/api/v1/docs/${docId}/inject-results`, headers: h, payload: JSON.stringify({ result: 'x' }) })
    expect(bad.statusCode).toBe(400)
  })
})

  test('study_type defaults to clinical; basic is accepted (#409)', async () => {
    const app = await getApp()
    const h = { ...await authHeader(), 'content-type': 'application/json' }

    const clinical = await app.inject({
      method: 'POST', url: '/api/v1/research/studies',
      headers: h, payload: JSON.stringify({ display_name: 'Trial X', short_code: 'TRIALX' }),
    })
    expect(JSON.parse(clinical.payload).study_type).toBe('clinical')

    const basic = await app.inject({
      method: 'POST', url: '/api/v1/research/studies',
      headers: h, payload: JSON.stringify({ display_name: 'Wet Lab Y', short_code: 'WETLAB', study_type: 'basic' }),
    })
    expect(JSON.parse(basic.payload).study_type).toBe('basic')

    const list = await app.inject({ method: 'GET', url: '/api/v1/research/studies', headers: await authHeader() })
    const studies = JSON.parse(list.payload)
    expect(studies.some((s: any) => s.study_type === 'basic')).toBe(true)

    const bad = await app.inject({
      method: 'POST', url: '/api/v1/research/studies',
      headers: h, payload: JSON.stringify({ display_name: 'Bad', short_code: 'BAD', study_type: 'nope' }),
    })
    expect(bad.statusCode).toBe(400)
  }, 30000)
