import { describe, test, expect, vi, afterEach } from 'vitest'
import { resolveLlmEndpoint, LLM_PROVIDERS, setLlmGatewayForTest } from '../../src/common/llm-gateway.js'
import { createAiProvider } from '../../src/common/ai/ai-provider.js'

/**
 * #202/#436: runtime LLM provider selection via DEFAULT_LLM_PROVIDER —
 * chat goes through the single LlmGateway.
 */
describe('runtime provider selection (#202/#436)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    setLlmGatewayForTest(null)
  })

  test('DEFAULT_LLM_PROVIDER=gemini routes chat to the Gemini OpenAI-compat endpoint', async () => {
    vi.stubEnv('DEFAULT_LLM_PROVIDER', 'gemini')
    vi.stubEnv('GEMINI_API_KEY', 'gkey')
    vi.stubEnv('DEFAULT_LLM_MODEL', 'gemini-2.5-flash')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = createAiProvider()
    const res = await provider.chat([{ role: 'user', content: 'hello' }], {})
    expect(res.content).toBe('hi')
    const url = fetchMock.mock.calls[0][0]
    expect(String(url)).toContain('generativelanguage.googleapis.com')
    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers.Authorization).toContain('gkey')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.model).toBe('gemini-2.5-flash')
  })

  test('unset provider defaults to DeepSeek (backward compatible)', async () => {
    vi.stubEnv('DEFAULT_LLM_PROVIDER', '')
    vi.stubEnv('DEEPSEEK_API_KEY', 'dkey')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = createAiProvider()
    await provider.chat([{ role: 'user', content: 'x' }], {})
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('api.deepseek.com')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toContain('dkey')
  })

  test('unknown provider throws', () => {
    vi.stubEnv('DEFAULT_LLM_PROVIDER', 'watson')
    expect(() => resolveLlmEndpoint()).toThrow(/Unknown DEFAULT_LLM_PROVIDER/)
  })

  test('provider registry covers all supported providers', () => {
    expect(Object.keys(LLM_PROVIDERS).sort()).toEqual(['anthropic', 'deepseek', 'gemini', 'kimi', 'opencode', 'openai'].sort())
  })
})
