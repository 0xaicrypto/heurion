import { describe, test, expect, vi, afterEach } from 'vitest'
import { resolveChatProvider } from '../../src/common/ai/openai-compatible-chat.provider.js'
import { createAiProvider } from '../../src/common/ai/ai-provider.js'

/**
 * #202: runtime LLM provider selection via DEFAULT_LLM_PROVIDER.
 */
describe('runtime provider selection (#202)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
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

  test('unknown provider throws config_missing', () => {
    vi.stubEnv('DEFAULT_LLM_PROVIDER', 'watson')
    expect(() => resolveChatProvider({})).toThrow(/Unknown DEFAULT_LLM_PROVIDER/)
  })
})
