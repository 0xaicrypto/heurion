import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getApp, authHeader } from './setup.js'

vi.mock('../src/common/llm.js', () => ({
  deepseekChat: vi.fn(),
  deepseekStream: vi.fn(),
  getApiKey: () => 'test-key',
  setLlmTelemetryService: vi.fn(),
  DEEPSEEK_CHAT_MODEL: 'deepseek-v4-flash',
  DEEPSEEK_PREMIUM_MODEL: 'deepseek-v4-pro',
}))

import { deepseekChat } from '../src/common/llm.js'

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

  test('malformed tool call falls back to the raw model text instead of crashing', async () => {
    const app = await getApp()
    const hash = await createPatient(app)

    vi.mocked(deepseekChat).mockImplementation((messages: any[]) => {
      const text = messages.map((m: any) => m.content || '').join('\n')
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      return Promise.resolve('<tool_call>{"name":"search_node","arguments":broken</tool_call>')
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '诊断一下', patient_hash: hash }),
    })
    expect(res.statusCode).toBe(200)
    // No crash: the raw model text is still delivered (escaped inside SSE JSON).
    expect(res.payload).toContain('search_node')
  })
})
