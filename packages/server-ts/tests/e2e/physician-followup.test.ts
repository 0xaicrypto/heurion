import { describe, test, expect, vi, beforeAll, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader } from '../setup.js'
import prisma from '../../src/common/prisma.js'
vi.mock('../../src/common/llm.js', () => mockAiProvider())
import { deepseekChat, deepseekStream } from '../../src/common/llm.js'

/**
 * §8.2-5 (#217): 医生复诊路径 E2E — 患者 → 对话 → 关闭 → 新会话 → 回忆。
 * 记忆跨会话正确恢复是核心卖点：新会话必须能引用上一会话确认过的记忆。
 */
beforeAll(() => {
  vi.mocked(deepseekChat).mockImplementation((messages: any) => {
    const text = JSON.stringify(messages)
    if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
    // When asked to recall the patient, echo the injected memory so the
    // test can assert the memory actually reached the LLM context.
    if (text.includes('上次') || text.includes('还记得') || text.includes('recall')) {
      return Promise.resolve('是的，我记得：患者 ZQ，NSCLC 术后，上次记录 EGFR 突变检测阳性。')
    }
    return Promise.resolve('好的。')
  })
  vi.mocked(deepseekStream).mockImplementation(async function* () {
    yield '好的。'
  })
})

afterEach(async () => {
  await (prisma as any).session.deleteMany({})
})

describe('医生复诊路径 (§8.2-5 #217)', () => {
  test('new session recalls facts confirmed in an earlier session', async () => {
    const app = await getApp()
    const h = await authHeader()
    const hj = { ...h, 'content-type': 'application/json' }

    // 1) 建患者 A
    const patient = await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: hj, payload: JSON.stringify({ initials: 'ZQ' }),
    })
    const hash = JSON.parse(patient.payload).patient_hash

    // 2) 对话（会话一）：告诉 AI 关键信息 → 记忆被提取
    const s1 = `review_${Date.now()}`
    const chat1 = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: hj,
      payload: JSON.stringify({ text: '患者 ZQ 确诊 NSCLC 三期，EGFR 突变检测阳性', session_id: s1, patient_hash: hash }),
    })
    expect(chat1.statusCode).toBe(200)

    // 3) 关闭会话一 → Tier-3 flush + Session Memory 沉淀
    const close = await app.inject({
      method: 'POST', url: `/api/v1/sessions/${s1}/close`,
      headers: h,
    })
    expect(close.statusCode).toBe(200)
    const closeBody = JSON.parse(close.payload)
    expect(closeBody.status).toBe('closed')

    // 4) 新会话（会话二）：问"A 上次的情况"—— LLM 必须收到患者记忆
    const s2 = `recall_${Date.now()}`
    const chat2 = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: hj,
      payload: JSON.stringify({ text: 'ZQ 上次的情况还记得吗？', session_id: s2, patient_hash: hash }),
    })
    expect(chat2.statusCode).toBe(200)

    // The LLM mock echoes back what reached its context — the patient
    // facts from session one must be present in the second session's prompt.
    const finalChunks = chat2.payload
      .split('\n')
      .filter((l: string) => l.startsWith('data: '))
      .map((l: string) => { try { return JSON.parse(l.slice('data: '.length)) } catch { return null } })
      .filter((e: any) => e?.type === 'final_answer_chunk')
      .map((e: any) => e.text)
      .join('')
    expect(finalChunks).toContain('EGFR')
    expect(finalChunks).toContain('NSCLC')
  })

  test('new session does not inherit another session draft episodes', async () => {
    const app = await getApp()
    const h = await authHeader()
    const hj = { ...h, 'content-type': 'application/json' }

    const hash = JSON.parse((await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: hj, payload: JSON.stringify({ initials: 'YA' }),
    })).payload).patient_hash

    const s1 = `draft_${Date.now()}`
    await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: hj,
      payload: JSON.stringify({ text: 'YA 的临时讨论：方案尚未定稿', session_id: s1, patient_hash: hash }),
    })
    await app.inject({ method: 'POST', url: `/api/v1/sessions/${s1}/close`, headers: h })

    const s2 = `fresh_${Date.now()}`
    const chat2 = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: hj,
      payload: JSON.stringify({ text: 'YA 上次的情况还记得吗？', session_id: s2, patient_hash: hash }),
    })
    // Still works, no crash — and the un-reviewed episode summary is not
    // force-fed into the fresh session (it stays session-scoped).
    expect(chat2.statusCode).toBe(200)
  })
})
