import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getAuthUserId } from './setup.js'
import { getUserContext } from '../src/modules/chat/user-context.js'
import { getExtractedUptoIdx } from '../src/memory/extraction-cursor.js'
import { extractSegment } from '../src/memory/compaction.js'

vi.mock('../src/common/llm.js', () => ({
  deepseekChat: vi.fn(),
  deepseekStream: vi.fn(),
  getApiKey: () => 'test-key',
  setLlmTelemetryService: vi.fn(),
  DEEPSEEK_CHAT_MODEL: 'deepseek-v4-flash',
  DEEPSEEK_PREMIUM_MODEL: 'deepseek-v4-pro',
}))

import { deepseekChat } from '../src/common/llm.js'

beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', 'test-key') })
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('#182 parse-failure safety', () => {
  test('first parse fails → retried with correction → facts extracted, cursor advances', async () => {
    const userId = await getAuthUserId()
    const ctx = getUserContext(userId)
    const sessionId = `pf_${Date.now()}`
    ctx.eventLog.append({ timestamp: Date.now() / 1000, eventType: 'user_message', content: '患者发热三天', metadata: {}, agentId: userId, sessionId })
    ctx.eventLog.append({ timestamp: Date.now() / 1000, eventType: 'assistant_response', content: '考虑感染', metadata: {}, agentId: userId, sessionId })

    let calls = 0
    vi.mocked(deepseekChat).mockImplementation(() => {
      calls++
      if (calls === 1) return Promise.resolve('抱歉，我无法生成 JSON')
      return Promise.resolve('[{"content":"患者发热三天，考虑感染","category":"symptom","importance":3,"sourceType":"patient"}]')
    })

    const n = await extractSegment({ ...ctx, userId }, sessionId, undefined, 0, ctx.eventLog.count())
    expect(n).toBe(1)
    // extraction attempts (2: fail + corrected retry) + K3 summary call
    expect(calls).toBeGreaterThanOrEqual(3)
    // the retry prompt carried the correction hint
    const retryContent = String(vi.mocked(deepseekChat).mock.calls[1][0][0].content)
    expect(retryContent).toContain('无法解析')
    const cursor = await getExtractedUptoIdx({ userId, scopeType: 'global', sessionId })
    expect(cursor).toBeGreaterThan(0)
  }, 30000)

  test('both attempts fail → throws, cursor does NOT advance (segment retried later)', async () => {
    const userId = await getAuthUserId()
    const ctx = getUserContext(userId)
    const sessionId = `pf2_${Date.now()}`
    ctx.eventLog.append({ timestamp: Date.now() / 1000, eventType: 'user_message', content: '患者发热三天', metadata: {}, agentId: userId, sessionId })
    ctx.eventLog.append({ timestamp: Date.now() / 1000, eventType: 'assistant_response', content: '考虑感染', metadata: {}, agentId: userId, sessionId })

    vi.mocked(deepseekChat).mockResolvedValue('抱歉，无法解析')

    await expect(
      extractSegment({ ...ctx, userId }, sessionId, undefined, 0, ctx.eventLog.count()),
    ).rejects.toThrow()

    const cursor = await getExtractedUptoIdx({ userId, scopeType: 'global', sessionId })
    expect(cursor).toBe(0)
  }, 30000)
})
