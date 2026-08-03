import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getApp, authHeader, getAuthUserId } from './setup.js'
import prisma from '../src/common/prisma.js'
import { getExtractedUptoIdx, advanceExtractedUptoIdx, shouldExtractIncrement } from '../src/memory/extraction-cursor.js'

vi.mock('../src/common/llm.js', () => ({
  deepseekChat: vi.fn(),
  deepseekStream: vi.fn(),
  getApiKey: () => 'test-key',
  setLlmTelemetryService: vi.fn(),
  DEEPSEEK_CHAT_MODEL: 'deepseek-v4-flash',
  DEEPSEEK_PREMIUM_MODEL: 'deepseek-v4-pro',
}))

import { deepseekChat } from '../src/common/llm.js'

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

describe('K2 event-driven trigger decision', () => {
  test('content >= 300 chars triggers extraction', () => {
    expect(shouldExtractIncrement('x'.repeat(300))).toBe(true)
    expect(shouldExtractIncrement('x'.repeat(299))).toBe(false)
  })

  test('key clinical signals trigger even under the threshold', () => {
    expect(shouldExtractIncrement('记住：患者对青霉素过敏')).toBe(true)
    expect(shouldExtractIncrement('诊断结果已确认')).toBe(true)
    expect(shouldExtractIncrement('调整剂量方案')).toBe(true)
    expect(shouldExtractIncrement('今天天气不错')).toBe(false)
  })
})

describe('K1+K2 incremental extraction via chat', () => {
  test('a short session with a key signal still proposes facts', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const sessionId = `k12_${Date.now()}`
    const patientHash = `patient_k12_${Date.now()}`

    // Register patient + seed a small conversation (2 turns < 5)
    await app.inject({
      method: 'POST', url: '/api/v1/dicom/patients/register-manual',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ initials: 'K2', age: 50, sex: 'M' }),
    })

    vi.mocked(deepseekChat).mockImplementation((messages) => {
      const text = JSON.stringify(messages)
      if (text.includes('intent classifier')) return Promise.resolve('mixed\n')
      if (text.includes('clinical memory extractor')) {
        return Promise.resolve('[{"category":"fact","importance":5,"content":"患者确诊肺癌","sourceType":"patient"}]')
      }
      return Promise.resolve('已记录。')
    })

    await app.inject({
      method: 'POST', url: '/api/v1/agent/chat',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '患者确诊肺癌，记得记录', session_id: sessionId, patient_hash: patientHash }),
    })

    // Debounce is 2s — wait for the scheduled extraction
    await new Promise((r) => setTimeout(r, 3200))

    // The fact should be proposed to the pending queue (short session, signal-triggered)
    const proposals = await (prisma as any).memoryProposal.findMany({
      where: { userId, kind: 'fact', status: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: 5,
    })
    expect(proposals.some((p: any) => p.content.includes('肺癌'))).toBe(true)

    // Cursor advanced past the extracted segment
    const idx = await getExtractedUptoIdx({ userId, scopeType: 'patient', patientHash })
    expect(idx).toBeGreaterThan(0)
  }, 30000)
})
