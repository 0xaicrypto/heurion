import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader } from '../setup.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

import { deepseekChat } from '../../src/common/llm.js'

/**
 * #454-followup: render_chart / render_scene are plugin-gated — they only
 * appear in the LLM tool list while heurion/chart / heurion/bioscene are
 * installed + enabled, and execute() refuses without the plugin.
 */
describe('plugin-gated render tools (#454-followup)', () => {
  beforeEach(() => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  test('render_chart is absent from tools without heurion/chart, and execute refuses', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }

    // LLM tries render_chart anyway (stale plan / instruction injection).
    vi.mocked(deepseekChat).mockImplementation((messages: any) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      return Promise.resolve(`<tool_call>${JSON.stringify({ name: 'render_chart', arguments: { type: 'bar', title: 'x' } })}</tool_call>`)
    })

    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat', headers,
      payload: JSON.stringify({ text: '画个图', session_id: `gated_${Date.now()}` }),
    })
    expect(res.statusCode).toBe(200)
    // No chart_created — the gated tool must not run.
    expect(res.payload).not.toContain('"type":"chart_created"')
    // The refusal is surfaced to the LLM as a tool error.
    expect(res.payload).toContain('插件')
  }, 30000)

  test('installing heurion/chart exposes render_chart to the LLM', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }

    const install = await app.inject({
      method: 'POST', url: '/api/v1/plugins/install', headers,
      payload: JSON.stringify({ pluginId: 'heurion/chart' }),
    })
    expect(install.statusCode).toBe(200)

    vi.mocked(deepseekChat).mockImplementation((messages: any) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      return Promise.resolve(`<tool_call>${JSON.stringify({ name: 'render_chart', arguments: { type: 'bar', data: [{ label: 'A', value: 1 }], title: 't' } })}</tool_call>`)
    })

    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat', headers,
      payload: JSON.stringify({ text: '画个图', session_id: `gated2_${Date.now()}` }),
    })
    expect(res.statusCode).toBe(200)
    // The render_chart definition (4th arg of deepseekChat) reached the LLM.
    const toolLoopCall = vi.mocked(deepseekChat).mock.calls.find((c) => !JSON.stringify(c[0]).includes('intent classifier'))
    expect(toolLoopCall).toBeDefined()
    // deepseekChat(messages, apiKey, options, tools, onReasoning) — tools is
    // the 4th argument.
    const toolsArg = (toolLoopCall![3] as Array<{ function: { name: string } }> | undefined) || []
    expect(Array.isArray(toolsArg)).toBe(true)
    expect(toolsArg.some((t) => t.function?.name === 'render_chart')).toBe(true)
    expect(res.payload).toContain('"type":"chart_created"')
  }, 30000)

  test('uninstalling heurion/bioscene removes render_scene again', async () => {
    const app = await getApp()
    const headers = { ...await authHeader(), 'content-type': 'application/json' }

    await app.inject({
      method: 'POST', url: '/api/v1/plugins/install', headers,
      payload: JSON.stringify({ pluginId: 'heurion/bioscene' }),
    })
    await app.inject({
      method: 'DELETE', url: '/api/v1/plugins/heurion/bioscene', headers,
    })

    vi.mocked(deepseekChat).mockImplementation((messages: any) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      return Promise.resolve('普通回答。')
    })

    await app.inject({
      method: 'POST', url: '/api/v1/agent/chat', headers,
      payload: JSON.stringify({ text: '画个信号通路图', session_id: `gated3_${Date.now()}` }),
    })
    // No render_scene definition in the tool-loop call.
    const toolLoopCall = vi.mocked(deepseekChat).mock.calls.find((c) => !JSON.stringify(c[0]).includes('intent classifier'))
    const toolsArg = (toolLoopCall?.[3] as Array<{ function: { name: string } }> | undefined) || []
    expect(toolsArg.some((t) => t.function.name === 'render_scene')).toBe(false)
  }, 30000)
})
