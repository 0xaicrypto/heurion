import { vi } from 'vitest'

/**
 * Shared mock for `../src/common/llm.js` — replaces the 20+ duplicated
 * `vi.mock('../src/common/llm.js', () => ({...}))` blocks across tests
 * (architecture optimization §8.2-3, #216).
 *
 * Usage in a test file:
 *   import { mockAiProvider } from './helpers/ai-mock.js'
 *   vi.mock('../src/common/llm.js', () => mockAiProvider())
 *
 * Note: vitest gives every test file its own module registry, so each file
 * gets a fresh mock instance when the factory runs.
 */
export function mockAiProvider() {
  const chat = vi.fn()
  return {
    deepseekChat: chat,
    // #548: truncation-aware variant delegates to deepseekChat so existing
    // tests keep working, but returns the { text, truncated } envelope that
    // runToolCallLoop now consumes.
    deepseekChatWithMeta: vi.fn(async (messages: any[], key: string, options: any, tools?: any, onReasoning?: any) => ({
      text: await chat(messages, key, options, tools, onReasoning),
      truncated: false,
    })),
    deepseekStream: vi.fn(),
    getApiKey: () => 'test-key',
    setLlmTelemetryService: vi.fn(),
    DEEPSEEK_CHAT_MODEL: 'deepseek-v4-flash',
    DEEPSEEK_PREMIUM_MODEL: 'deepseek-v4-pro',
  }
}

/** Prompt marker of the #557 intent adjudicator (see intent-router.ts). */
export const INTENT_PROMPT_MARKER = 'intent classifier'

/**
 * #557 — e2e LLM mocks must answer the sidecar intent adjudication before
 * producing their usual content: resolveSidecarIntent is the first LLM call in
 * the chat pipeline, so a single mockResolvedValue/mockImplementation would be
 * consumed by the adjudicator and the content generation would never run.
 * Wrap the content mock so the adjudicator call gets a fixed answer instead.
 *
 * Example: intentAware(() => JSON_CONTENT, 'generate')
 *   → adjudicator receives 'generate' (or your value in the 2nd arg),
 *     content-generation calls receive JSON_CONTENT.
 */
export function intentAware(
  contentImpl: (messages: any[], ...rest: any[]) => any,
  adjudicatorAnswer: string = 'generate',
) {
  return (messages: any[], ...rest: any[]) => {
    const last = messages.at(-1)?.content
    if (typeof last === 'string' && last.includes(INTENT_PROMPT_MARKER)) return adjudicatorAnswer
    return contentImpl(messages, ...rest)
  }
}
