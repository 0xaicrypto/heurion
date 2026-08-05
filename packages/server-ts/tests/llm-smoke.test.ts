import { describe, test, expect } from 'vitest'
import { deepseekChat } from '../src/common/llm.js'
import { OpenAIEmbeddingProvider } from '../src/common/ai/openai-embedding.provider.js'

/**
 * Real-provider smoke tests (architecture optimization §8.2-3, #216).
 * Skipped unless a REAL provider key is present — the vitest config no
 * longer injects a placeholder, so CI (no key) skips these by default.
 * Run manually:
 *   DEEPSEEK_API_KEY=... OPENAI_API_KEY=... pnpm exec vitest run tests/llm-smoke.test.ts
 */
const realKey = process.env.DEEPSEEK_API_KEY
const realOpenAiKey = process.env.OPENAI_API_KEY

describe('LLM smoke (real provider)', () => {
  test.skipIf(!realKey)('deepseekChat returns a completion', async () => {
    const out = await deepseekChat([{ role: 'user', content: 'Say OK' }], realKey!, {
      model: 'deepseek-chat',
      maxTokens: 64,
    })
    expect(typeof out).toBe('string')
    expect(out!.length).toBeGreaterThan(0)
  }, 60000)

  test.skipIf(!realOpenAiKey)('embedder returns a vector', async () => {
    const embedder = new OpenAIEmbeddingProvider()
    const v = await embedder.embed(['hello'])
    expect(Array.isArray(v)).toBe(true)
    expect(v[0].length).toBeGreaterThan(0)
  }, 60000)
})
