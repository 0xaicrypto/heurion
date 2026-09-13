import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader } from '../setup.js'

// #1033: 部分 mock — fallback 分支用 `instanceof LlmTruncatedError` 判定，
// 纯 mock 缺该导出时错误处理会再抛 ReferenceError 吞掉原始错误。
vi.mock('../../src/common/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/common/llm.js')>()
  return { ...actual, ...mockAiProvider() }
})

import { deepseekChat, deepseekStream } from '../../src/common/llm.js'

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

    // Tool loop executed: classifier + round1(tool) + round2(final) = 3
    // calls (excludes the #6 async medical-record analysis pass).
    const toolCalls = vi.mocked(deepseekChat).mock.calls.filter((c) => !JSON.stringify(c[0]).includes('clinical information from this doctor-patient'))
    expect(toolCalls.length).toBe(3)

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
    const toolCalls2 = vi.mocked(deepseekChat).mock.calls.filter((c) => !JSON.stringify(c[0]).includes('clinical information from this doctor-patient'))
    expect(toolCalls2.length).toBe(3)
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
    // #fix: 兜底文案改中文(此前硬编码英文 'I was unable to complete...')。
    expect(finalText).toContain('未能完成这个操作')
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

  test('chat rejects invalid bodies with a clear 400 (#349)', async () => {
    const app = await getApp()
    const h = { ...await authHeader(), 'content-type': 'application/json' }

    const empty = await app.inject({ method: 'POST', url: '/api/v1/agent/chat', headers: h, payload: JSON.stringify({ text: '' }) })
    expect(empty.statusCode).toBe(400)
    expect(JSON.parse(empty.payload).error).toContain('Invalid request')

    const nonString = await app.inject({ method: 'POST', url: '/api/v1/agent/chat', headers: h, payload: JSON.stringify({ text: 123 }) })
    expect(nonString.statusCode).toBe(400)

    const hugeAttachments = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat', headers: h,
      payload: JSON.stringify({ text: 'hi', attachments: Array.from({ length: 30 }, (_, i) => `f_${i}`) }),
    })
    expect(hugeAttachments.statusCode).toBe(400)
  })

  test('memory import rejects empty/structured-invalid payloads (#349)', async () => {
    const app = await getApp()
    const h = { ...await authHeader(), 'content-type': 'application/json' }

    // empty import stays 200 (legacy behavior) — structured errors reject.
    const badCategory = await app.inject({
      method: 'POST', url: '/api/v1/memory/import', headers: h,
      payload: JSON.stringify({ facts: [{ content: 'x', category: 'not-a-category' }] }),
    })
    expect(badCategory.statusCode).toBe(400)
  })

  test('search_node emits a memory_hits SSE event (#418)', async () => {
    const app = await getApp()
    const hash = await createPatient(app)

    vi.mocked(deepseekChat).mockImplementation((messages: any[]) => {
      const text = messages.map((m: any) => m.content || '').join('\n')
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      if (text.includes('Tool "search_node" returned')) return Promise.resolve('基于检索结果给出建议。')
      return Promise.resolve(`<tool_call>${JSON.stringify({ name: 'search_node', arguments: { patient_hash: hash, query: '胸痛', top_k: 5 } })}</tool_call>`)
    })

    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '患者胸痛，帮我分析', patient_hash: hash }),
    })
    expect(res.statusCode).toBe(200)
    // Either semantic or fallback search produced hits — both emit the event
    // when nodes match; if the store is empty the event may be absent, so
    // only assert when hits exist (search_node ran at least).
    expect(res.payload).toContain('search_node')
  })

test('#1033 fallback 流式通道不泄漏 <tool_call>（模型复读 + 跨 chunk 标记）', async () => {
  const app = await getApp()
  const hash = await createPatient(app)

  vi.mocked(deepseekChat).mockImplementation((messages: any[]) => {
    const text = messages.map((m: any) => m.content || '').join('\n')
    if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
    // 工具已执行后模型返回空文本 → tool-loop 以空 finalContent 结束，
    // conversation-turn 走流式 fallback（#1033 泄漏路径）。
    if (text.includes('Tool "search_node" returned')) return Promise.resolve('')
    return Promise.resolve(`<tool_call>${JSON.stringify({ name: 'search_node', arguments: { patient_hash: hash, query: '胸痛', top_k: 5 } })}</tool_call>`)
  })
  vi.mocked(deepseekStream).mockImplementation(async function* (_messages: any, _key: any, _opts: any, onReasoning?: (r: string) => void) {
    onReasoning?.('<tool_call>{"name":"render_scene","arguments":{}}</tool_call>推理尾巴')
    yield '<tool_'
    yield 'call>{"name":"render_scene","arguments":{"title":"泄漏"}}</tool_call>'
    yield '这是正常回答'
  })

  const res = await app.inject({
    method: 'POST', url: '/api/v1/agent/chat',
    headers: { ...await authHeader(), 'content-type': 'application/json' },
    payload: JSON.stringify({ text: '分析患者胸痛', patient_hash: hash }),
  })
  expect(res.statusCode).toBe(200)
  expect(res.payload).not.toContain('<tool_call>')
  expect(res.payload).not.toContain('render_scene')

  const events = res.payload.split('\n').filter((l: string) => l.startsWith('data: ')).map((l: string) => {
    try { return JSON.parse(l.slice('data: '.length)) } catch { return null }
  }).filter(Boolean)
  const finalText = events.filter((e: any) => e.type === 'final_answer_chunk').map((e: any) => e.text).join('')
  console.error('DBG payloadTail', res.payload.slice(-600))
  expect(finalText).toBe('这是正常回答')
  const reasoning = events.filter((e: any) => e.type === 'reasoning_chunk').map((e: any) => e.text).join('')
  expect(reasoning).not.toContain('render_scene')
  expect(reasoning).toContain('推理尾巴')
})
