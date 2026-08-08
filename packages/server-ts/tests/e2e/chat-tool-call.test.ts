import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
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

async function createPatient(app: any) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/dicom/patients/register-manual',
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: { initials: 'TC', age: 65, sex: 'F', chief_complaint: 'fever, chest pain, cough' },
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.payload).patient_hash
}

describe('chat tool-call parsing (regression: nested arguments JSON)', () => {
  test('a <tool_call> with nested arguments is executed, not echoed as text', async () => {
    const app = await getApp()
    const hash = await createPatient(app)

    const toolCall = { name: 'search_node', arguments: { patient_hash: hash, query: '胸痛 咳嗽 发热', top_k: 8 } }

    vi.mocked(deepseekChat).mockImplementation((messages: any[]) => {
      const text = messages.map((m: any) => m.content || '').join('\n')
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      if (text.includes('Tool "search_node" returned')) return Promise.resolve('初步诊断：考虑肺炎，建议胸部CT检查。')
      return Promise.resolve(`<tool_call>${JSON.stringify(toolCall)}</tool_call>`)
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '患者发热持续3周，胸痛伴随咳嗽。先做一个初步诊断', patient_hash: hash }),
    })
    expect(res.statusCode).toBe(200)
    require('fs').appendFileSync('/tmp/opencode/calls.txt', vi.mocked(deepseekChat).mock.calls.map((c: any) => {
      const users = (c[0] as any[]).filter((m: any) => m.role === 'user')
      return JSON.stringify(users[users.length - 1]?.content ?? '(none)')
    }).join('\n---\n') + '\n=======\n')

    // Tool loop executed: classifier + round1(tool) + round2(final) = 3 calls.
    expect(deepseekChat).toHaveBeenCalledTimes(3)

    // Final answer streamed; no raw tool_call markup in the SSE payload.
    expect(res.payload).toContain('初步诊断')
    expect(res.payload).not.toContain('<tool_call>')

    // Tool result was fed back to the model in round 2.
    const round2Messages = vi.mocked(deepseekChat).mock.calls[2][0] as Array<{ role: string; content: string }>
    expect(round2Messages.some((m) => m.role === 'user' && m.content.includes('Tool "search_node" returned'))).toBe(true)
  })

  test('multiple <tool_call> blocks in one response are all executed', async () => {
    const app = await getApp()
    const hash = await createPatient(app)

    const first = { name: 'search_node', arguments: { patient_hash: hash, query: 'fever', top_k: 4 } }
    const second = { name: 'search_encounter', arguments: { patient_hash: hash, query: 'cough', top_k: 4 } }

    vi.mocked(deepseekChat).mockImplementation((messages: any[]) => {
      const text = messages.map((m: any) => m.content || '').join('\n')
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      if (text.includes('Tool "search_encounter" returned')) return Promise.resolve('综合两次查询结果给出建议。')
      return Promise.resolve(`<tool_call>${JSON.stringify(first)}</tool_call>\n<tool_call>${JSON.stringify(second)}</tool_call>`)
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '汇总该患者情况', patient_hash: hash }),
    })
    expect(res.statusCode).toBe(200)
    expect(deepseekChat).toHaveBeenCalledTimes(3)
    expect(res.payload).toContain('综合两次查询结果给出建议')
    expect(res.payload).not.toContain('<tool_call>')

    // Both tools were fed back to the model in round 2.
    const round2Messages = vi.mocked(deepseekChat).mock.calls[2][0] as Array<{ role: string; content: string }>
    expect(round2Messages.some((m) => m.content.includes('Tool "search_node" returned'))).toBe(true)
    expect(round2Messages.some((m) => m.content.includes('Tool "search_encounter" returned'))).toBe(true)
  })

  test('malformed tool call is retried and never leaks raw markers (§3.3 #193)', async () => {
    const app = await getApp()
    const hash = await createPatient(app)

    vi.mocked(deepseekChat).mockImplementation((messages: any[]) => {
      const text = messages.map((m: any) => m.content || '').join('\n')
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      // Keep failing with malformed JSON so the loop exhausts its rounds.
      return Promise.resolve('<tool_call>{"name":"search_node","arguments":broken</tool_call>')
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '诊断一下', patient_hash: hash }),
    })
    expect(res.statusCode).toBe(200)
    // No raw <tool_call> marker may reach the user (§3.3).
    expect(res.payload).not.toContain('<tool_call>')
    // The model was told to re-emit valid JSON (malformed_arguments retry).
    const events = res.payload.split('\n').filter((l: string) => l.startsWith('data: ')).map((l: string) => {
      try { return JSON.parse(l.slice('data: '.length)) } catch { return null }
    }).filter(Boolean)
    expect(events.some((e: any) => e.type === 'error')).toBe(false)
    const finalText = events.filter((e: any) => e.type === 'final_answer_chunk').map((e: any) => e.text).join('')
    expect(finalText).toContain('unable to complete')
  })
})

  test('delegate tool emits subagent_started/subagent_done SSE events (#350)', async () => {
    const app = await getApp()
    const hash = await createPatient(app)

    vi.mocked(deepseekChat).mockImplementation((messages: any[]) => {
      const text = messages.map((m: any) => m.content || '').join('\n')
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      if (text.includes('Tool "delegate" returned')) return Promise.resolve('汇总：文献与统计子任务完成。')
      if (text.includes('You are a helpful sub-agent')) return Promise.resolve('子任务结果：检索到 3 篇相关文献')
      return Promise.resolve(`<tool_call>${JSON.stringify({ name: 'delegate', arguments: { task: '检索 EGFR NSCLC 免疫治疗文献' } })}</tool_call>`)
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '帮我检索文献并总结', patient_hash: hash }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('subagent_started')
    expect(res.payload).toContain('subagent_done')
    expect(res.payload).toContain('检索 EGFR NSCLC 免疫治疗文献')
    expect(res.payload).toContain('汇总：文献与统计子任务完成')
  })
