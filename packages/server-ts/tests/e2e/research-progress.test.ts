import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader } from '../setup.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

/**
 * #10: study progress overview — enrollment by arm, rule confirmation,
 * visits, safety and screening counts.
 */
describe('research progress (#10)', () => {
  beforeEach(() => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  test('progress aggregates enrollment/rules/visits/safety/screenings', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }

    const study = await app.inject({
      method: 'POST', url: '/api/v1/research/studies', headers,
      payload: JSON.stringify({ display_name: 'P 研究', short_code: 'P01' }),
    })
    const studyId = JSON.parse(study.payload).study_id

    // Enroll 2 patients into two arms.
    await app.inject({ method: 'POST', url: `/api/v1/research/studies/${studyId}/enrollments`, headers, payload: JSON.stringify({ patient_hash: 'p-a', arm: 'Arm A' }) })
    await app.inject({ method: 'POST', url: `/api/v1/research/studies/${studyId}/enrollments`, headers, payload: JSON.stringify({ patient_hash: 'p-b', arm: 'Arm B' }) })

    // Screening rows (direct DB write is fine — mirrors the service output).
    const prisma = (await import('../../src/common/prisma.js')).default
    await (prisma as any).researchScreening.create({ data: { id: 'scr1', studyId, patientHash: 'p-a', verdict: 'eligible', reason: '', criteriaResults: JSON.stringify([{ ruleId: 'r1', rule: 'I', category: 'inclusion', passed: true, detail: 'ok' }]), scannedAt: new Date().toISOString() } })
    await (prisma as any).researchScreening.create({ data: { id: 'scr2', studyId, patientHash: 'p-b', verdict: 'ineligible', reason: 'no', criteriaResults: '[]', scannedAt: new Date().toISOString() } })

    // Assessment rows.
    await (prisma as any).researchAssessment.create({ data: { id: 'as1', studyId, patientHash: 'p-a', visit: 'Cycle 1 Day 1', title: 'Cycle 1 Day 1', dueAt: new Date().toISOString(), completedAt: new Date().toISOString() } })
    await (prisma as any).researchAssessment.create({ data: { id: 'as2', studyId, patientHash: 'p-b', visit: 'Cycle 1 Day 8', title: 'Cycle 1 Day 8', dueAt: new Date().toISOString() } })

    const res = await app.inject({
      method: 'GET', url: `/api/v1/research/studies/${studyId}/progress`, headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.enrollment.total).toBe(2)
    expect(body.enrollment.by_arm['Arm A']).toBe(1)
    expect(body.screenings.eligible).toBe(1)
    expect(body.screenings.ineligible).toBe(1)
    expect(body.visits.total).toBe(2)
    expect(body.visits.completed).toBe(1)
    expect(body.visits.by_visit['Cycle 1 Day 1'].completed).toBe(1)
    expect(body.generated_at).toBeDefined()
  }, 30000)
})
