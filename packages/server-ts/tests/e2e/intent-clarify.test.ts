import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest'
import { mockAiProvider, intentAware } from '../helpers/ai-mock.js'
import { getApp, authHeader } from '../setup.js'
import { deepseekChat } from '../../src/common/llm.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

/**
 * #561 — intent_clarify SSE event:
 * - LLM verdict 'uncertain' (mixed/ambiguous request) → not generated, but a
 *   clarification hint is streamed so the UI can offer an explicit generate.
 * - 'generate' → plugin flow, no clarification.
 * - vetoed (edit/discuss) → normal conversation, no clarification.
 */
function parseEvents(payload: string): any[] {
  return payload
    .split('\n\n')
    .flatMap((block: string) =>
      block
        .split('\n')
        .filter((line: string) => line.startsWith('data: '))
        .map((line: string) => {
          try {
            return JSON.parse(line.slice('data: '.length))
          } catch {
            return null
          }
        })
        .filter(Boolean)
    )
}

describe('#561 intent_clarify 三态上报', () => {
  beforeAll(async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  test('uncertain → 不生成但发送 intent_clarify 事件', async () => {
    vi.mocked(deepseekChat).mockImplementation(intentAware(() => 'uncertain', 'uncertain'))
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      headers,
      payload: JSON.stringify({ text: '先讨论一下这个表格，然后导出成 PDF', session_id: 'clarify_uncertain' }),
    })
    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.payload)
    const clarify = events.find((e: any) => e.type === 'intent_clarify')
    expect(clarify).toBeDefined()
    // #561/#581: 结构化 options（前端渲染选择气泡），text 为提示文案。
    expect(Array.isArray(clarify.options)).toBe(true)
    expect(clarify.options).toContain('生成文档')
    expect(clarify.options).toContain('先讨论')
  })

  test('明确的生成请求 → 不发送 intent_clarify', async () => {
    vi.mocked(deepseekChat).mockImplementation(intentAware(() => 'generate', 'generate'))
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      headers,
      payload: JSON.stringify({ text: '帮我生成一份出院小结 docx', session_id: 'clarify_generate' }),
    })
    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.payload)
    expect(events.some((e: any) => e.type === 'intent_clarify')).toBe(false)
  })

  test('编辑/讨论句（否决）→ 不发送 intent_clarify（零 LLM）', async () => {
    const spy = vi.mocked(deepseekChat).mockImplementation(() => 'generate')
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      headers,
      payload: JSON.stringify({ text: '帮我润色修改一下这篇论文', session_id: 'clarify_vetoed' }),
    })
    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.payload)
    expect(events.some((e: any) => e.type === 'intent_clarify')).toBe(false)
  })
})
