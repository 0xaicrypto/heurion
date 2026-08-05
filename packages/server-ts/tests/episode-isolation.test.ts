import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from './helpers/ai-mock.js'
import { selectProjectionInputs } from '../src/modules/chat/chat.router.js'
import type { RouterResult } from '../src/retrieval/query-router.js'

vi.mock('../src/common/llm.js', () => mockAiProvider())

beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', 'test-key') })
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

function mockCtx() {
  const episodes = [
    { sessionId: 'session_A', summary: 'A 会话摘要：患者青霉素过敏（未审核）', turnCount: 3, createdAt: 0, updatedAt: 0 },
    { sessionId: 'session_B', summary: 'B 会话摘要：患者血压稳定', turnCount: 2, createdAt: 0, updatedAt: 0 },
  ]
  return {
    episodes: { all: () => episodes },
    facts: { all: () => [] },
    skills: { all: () => [] },
  } as any
}

describe('episode isolation (un-reviewed summaries stay in their session)', () => {
  test('mixed intent injects ONLY the current session episodes', () => {
    const route = { intent: 'mixed' } as RouterResult
    const out = selectProjectionInputs(route, mockCtx(), undefined, 'session_B')
    expect(out.episodes).toHaveLength(1)
    expect(out.episodes[0].sessionId).toBe('session_B')
    expect(out.episodes[0].summary).toContain('血压稳定')
  })

  test('a brand-new session gets NO episodes from other sessions', () => {
    const route = { intent: 'mixed' } as RouterResult
    const out = selectProjectionInputs(route, mockCtx(), undefined, 'session_new')
    expect(out.episodes).toHaveLength(0)
  })

  test('vector intent still skips episodes entirely', () => {
    const route = { intent: 'vector' } as RouterResult
    const out = selectProjectionInputs(route, mockCtx(), undefined, 'session_A')
    expect(out.episodes).toHaveLength(0)
  })
})
