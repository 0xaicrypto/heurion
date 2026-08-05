import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from './helpers/ai-mock.js'
import { getAuthUserId } from './setup.js'
import prisma from '../src/common/prisma.js'
import { getUserContext } from '../src/modules/chat/user-context.js'
import { getExtractedUptoIdx, advanceExtractedUptoIdx, type ExtractionCursorKey } from '../src/memory/extraction-cursor.js'
import { extractSegment } from '../src/memory/compaction.js'

vi.mock('../src/common/llm.js', () => mockAiProvider())

import { deepseekChat } from '../src/common/llm.js'

beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', 'test-key') })
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('#181 cross-session cursor safety', () => {
  test('session A flush does NOT skip session B events (cursor stops at A segment end)', async () => {
    const userId = await getAuthUserId()
    const ctx = getUserContext(userId)
    const sessionA = `csa_${Date.now()}`
    const sessionB = `csb_${Date.now()}`
    const scopeKeyA: ExtractionCursorKey = { userId, scopeType: 'global', sessionId: sessionA }
    const scopeKeyB: ExtractionCursorKey = { userId, scopeType: 'global', sessionId: sessionB }

    const aEvents: number[] = []
    const bEvents: number[] = []
    const mk = (sessionId: string, text: string) => {
      const evt = ctx.eventLog.append({ timestamp: Date.now() / 1000, eventType: 'user_message', content: text, metadata: {}, agentId: userId, sessionId })
      ;(sessionId === sessionA ? aEvents : bEvents).push(evt.idx)
    }

    // Interleaved writes across two sessions
    mk(sessionA, 'A 第一轮')
    mk(sessionB, 'B 第一轮')
    mk(sessionA, 'A 第二轮')
    mk(sessionB, 'B 第二轮')

    vi.mocked(deepseekChat).mockResolvedValue('[]')

    // Session A closes → flush extracts A's segment only
    const aMax = Math.max(...aEvents)
    await extractSegment({ ...ctx, userId }, sessionA, undefined, 0, ctx.eventLog.count())

    // A's per-session cursor stops at A's segment end
    const cursorAfterA = await getExtractedUptoIdx(scopeKeyA)
    expect(cursorAfterA).toBe(aMax)

    // Session B closes → its per-session cursor is untouched → all B events extracted
    await extractSegment({ ...ctx, userId }, sessionB, undefined, 0, ctx.eventLog.count())
    const cursorAfterB = await getExtractedUptoIdx(scopeKeyB)
    const bMax = Math.max(...bEvents)
    expect(cursorAfterB).toBe(bMax)

    // And A's cursor did not move
    expect(await getExtractedUptoIdx(scopeKeyA)).toBe(aMax)
  }, 30000)

  test('advanceExtractedUptoIdx never regresses the cursor', async () => {
    const userId = await getAuthUserId()
    const scopeKey: ExtractionCursorKey = { userId, scopeType: 'global' }
    await advanceExtractedUptoIdx(scopeKey, 50)
    await advanceExtractedUptoIdx(scopeKey, 10)
    expect(await getExtractedUptoIdx(scopeKey)).toBe(50)
  }, 30000)
})
