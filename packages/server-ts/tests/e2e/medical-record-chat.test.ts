import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader } from '../setup.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

import { deepseekChat } from '../../src/common/llm.js'

/**
 * #6: plain-text patient chats auto-update the STRUCTURED medical record
 * (not just the patient profile), rate-limited to one LLM pass per ~15s.
 */
describe('AI medical-record update (#6)', () => {
  beforeEach(() => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  test('text-only patient chat writes structured sections to the record', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }
    const userId = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/user/profile', headers: await authHeader() })).payload).user_id

    // Create a patient.
    const pat = await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual', headers,
      payload: JSON.stringify({ initials: 'ZL', age: 52, sex: 'M', chief_complaint: '咳嗽' }),
    })
    const hash = JSON.parse(pat.payload).patient_hash

    // LLM: classifier → mixed; analysis → sections + findings.
    vi.mocked(deepseekChat).mockImplementation((messages: any) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      if (text.includes('clinical information from this doctor-patient')) {
        return Promise.resolve(JSON.stringify({
          findings: [{ finding_type: 'diagnosis', content: '肺腺癌 IV 期', confidence: 0.9 }],
          sections: { diagnosis: '肺腺癌 IV 期', treatment_plan: '奥希替尼 80mg qd', progress_notes: '本次就诊主诉咳嗽加重' },
        }))
      }
      return Promise.resolve('已记录。')
    })

    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat', headers,
      payload: JSON.stringify({ text: '患者诊断肺腺癌IV期，已用奥希替尼治疗', patient_hash: hash, session_id: `mr_chat_${Date.now()}` }),
    })
    expect(res.statusCode).toBe(200)

    // Structured record updated (async analysis — poll briefly).
    let record: any = null
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300))
      const r = await app.inject({
        method: 'GET', url: `/api/v1/medical-records?patient_hash=${hash}`, headers: await authHeader(),
      })
      const body = JSON.parse(r.payload)
      if (body.records?.length > 0) { record = body.records[0]; break }
    }
    expect(record).toBeDefined()
    const sections = record.sections
    expect(sections.diagnosis).toContain('肺腺癌')
    expect(sections.treatment_plan).toContain('奥希替尼')
  }, 30000)

  test('manual sections are preserved on later AI updates', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }
    const userId = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/user/profile', headers: await authHeader() })).payload).user_id

    const pat = await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual', headers,
      payload: JSON.stringify({ initials: 'WM', age: 61, sex: 'F' }),
    })
    const hash = JSON.parse(pat.payload).patient_hash

    // Doctor creates a manual record with a family_history section.
    await app.inject({
      method: 'POST', url: '/api/v1/medical-records', headers,
      payload: JSON.stringify({ patient_hash: hash, title: '手写病历', sections: { family_history: '父亲肺癌' } }),
    })

    // AI chat updates only diagnosis — family_history must survive.
    vi.mocked(deepseekChat).mockImplementation((messages: any) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      if (text.includes('clinical information from this doctor-patient')) {
        return Promise.resolve(JSON.stringify({ findings: [], sections: { diagnosis: 'IIIA 期' } }))
      }
      return Promise.resolve('ok')
    })
    await app.inject({
      method: 'POST', url: '/api/v1/agent/chat', headers,
      payload: JSON.stringify({ text: '患者分期 IIIA', patient_hash: hash, session_id: `mr_chat2_${Date.now()}` }),
    })

    let sections: any = null
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300))
      const r = await app.inject({
        method: 'GET', url: `/api/v1/medical-records?patient_hash=${hash}`, headers: await authHeader(),
      })
      const body = JSON.parse(r.payload)
      if (body.records?.[0]?.sections?.diagnosis) { sections = body.records[0].sections; break }
    }
    expect(sections).toBeDefined()
    expect(sections.diagnosis).toContain('IIIA')
    expect(sections.family_history).toContain('父亲肺癌')
  }, 30000)
})
