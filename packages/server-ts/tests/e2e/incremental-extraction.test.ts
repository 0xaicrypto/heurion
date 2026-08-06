import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from '../helpers/ai-mock.js'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'
import { getExtractedUptoIdx, advanceExtractedUptoIdx } from '../../src/memory/extraction-cursor.js'

vi.mock('../../src/common/llm.js', () => mockAiProvider())

import { deepseekChat } from '../../src/common/llm.js'

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('K1 extraction cursor', () => {
  test('advance and read the per-scope cursor', async () => {
    const userId = await getAuthUserId()
    const key = { userId, scopeType: 'patient' as const, patientHash: 'patient_c1' }

    expect(await getExtractedUptoIdx(key)).toBe(0)
    await advanceExtractedUptoIdx(key, 42)
    expect(await getExtractedUptoIdx(key)).toBe(42)

    // Different patient → independent cursor
    const other = { userId, scopeType: 'patient' as const, patientHash: 'patient_c2' }
    expect(await getExtractedUptoIdx(other)).toBe(0)
  })

  test('global scope cursor is separate from patient scope', async () => {
    const userId = await getAuthUserId()
    await advanceExtractedUptoIdx({ userId, scopeType: 'global' }, 7)
    expect(await getExtractedUptoIdx({ userId, scopeType: 'global' })).toBe(7)
    expect(await getExtractedUptoIdx({ userId, scopeType: 'patient' as const, patientHash: 'p' })).toBe(0)
  })
})

describe('S1 — no real-time extraction', () => {
  test('chatting with clinical words produces NO extraction (no Tier 1)', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const sessionId = `s1_${Date.now()}`

    vi.mocked(deepseekChat).mockImplementation((messages) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      if (text.includes('clinical memory extractor')) {
        return Promise.resolve('[{"category":"fact","importance":5,"content":"患者确诊肺癌","sourceType":"patient"}]')
      }
      return Promise.resolve('已记录。')
    })

    // "诊断/方案" 等临床词 + 显式"记得"都不会触发实时提取
    await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '诊断结果已确认，请记得这个方案', session_id: sessionId }),
    })
    await new Promise((r) => setTimeout(r, 3200))

    const proposals = await (prisma as any).memoryProposal.findMany({
      where: { userId, kind: 'fact', status: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: 5,
    })
    // 无实时提取 → 聊天本身不产生 pending（提取只在压缩/关闭时）
    expect(proposals.filter((p: any) => p.content.includes('肺癌'))).toHaveLength(0)
  }, 30000)
})


