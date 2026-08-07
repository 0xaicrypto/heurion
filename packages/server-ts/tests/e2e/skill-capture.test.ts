import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader } from '../setup.js'
import prisma from '../../src/common/prisma.js'
vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat } from '../../src/common/llm.js'

/**
 * #298: skill capture — draft → natural-language refine → confirm.
 */
beforeAll(() => {
  vi.mocked(deepseekChat).mockImplementation((messages: any) => {
    const text = JSON.stringify(messages)
    if (text.includes('微调要求')) {
      return Promise.resolve(JSON.stringify({ name: '复发风险评估', description: '随访时评估复发风险', steps: ['收集复发风险因素', '评估', '记录'], prompt: '评估复发风险并记录。' }))
    }
    return Promise.resolve(JSON.stringify({ name: 'SOAP 笔记', description: '生成结构化 SOAP 笔记', steps: ['收集主观信息', '客观检查', '评估', '计划'], prompt: '请生成 SOAP 笔记。' }))
  })
})

beforeEach(async () => {
  await (prisma as any).capturedSkill.deleteMany({})
})

describe('skill capture (#298)', () => {
  test('capture → refine → confirm lifecycle', async () => {
    const app = await getApp()
    const h = await authHeader()
    const hj = { ...h, 'content-type': 'application/json' }

    const captured = await app.inject({
      method: 'POST', url: '/api/v1/skills/capture',
      headers: hj,
      payload: JSON.stringify({ conversation: '医生：请总结这次查房。\nAI：好的，第一步收集…第二步…', session_id: 's1' }),
    })
    expect(captured.statusCode).toBe(200)
    const draft = JSON.parse(captured.payload)
    expect(draft.draft_id).toBeTruthy()
    expect(draft.name).toBe('SOAP 笔记')
    expect(draft.steps.length).toBeGreaterThan(0)

    const refined = await app.inject({
      method: 'POST', url: `/api/v1/skills/capture/${draft.draft_id}/refine`,
      headers: hj,
      payload: JSON.stringify({ instruction: '下次别忘了加上复发风险' }),
    })
    expect(refined.statusCode).toBe(200)
    const refinedBody = JSON.parse(refined.payload)
    expect(refinedBody.name).toBe('复发风险评估')

    const confirmed = await app.inject({
      method: 'POST', url: `/api/v1/skills/capture/${draft.draft_id}/confirm`,
      headers: h,
    })
    expect(confirmed.statusCode).toBe(200)

    const list = await app.inject({ method: 'GET', url: '/api/v1/skills/captured', headers: h })
    const skills = JSON.parse(list.payload).skills
    expect(skills.some((s: any) => s.id === draft.draft_id && s.status === 'confirmed')).toBe(true)
  })

  test('capture without conversation → 400; refine unknown draft → 404', async () => {
    const app = await getApp()
    const h = await authHeader()
    const hj = { ...h, 'content-type': 'application/json' }
    const bad = await app.inject({ method: 'POST', url: '/api/v1/skills/capture', headers: hj, payload: JSON.stringify({}) })
    expect(bad.statusCode).toBe(400)
    const refine = await app.inject({
      method: 'POST', url: '/api/v1/skills/capture/draft_nonexistent/refine',
      headers: hj, payload: JSON.stringify({ instruction: 'x' }),
    })
    expect(refine.statusCode).toBe(404)
  })
})
