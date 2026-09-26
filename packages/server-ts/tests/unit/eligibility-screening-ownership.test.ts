import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * Rule 4 / P0 — screenPatient 研究归属校验。
 *
 * 修复前：screenPatient 用 findUnique({ where: { id: studyId } }) 只按主键
 * 查研究 — 传入他人 studyId 也会照常读取协议规则、把筛查结论写进他人研究。
 * 修复后：findFirst({ where: { id, userId } }) fail-closed。
 */
const mocks = vi.hoisted(() => ({
  studyFindFirst: vi.fn(),
  ruleFindMany: vi.fn(),
  patientFindUnique: vi.fn(),
  screeningCreate: vi.fn(),
  deepseekChat: vi.fn(),
  factsAll: vi.fn(),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    researchStudy: { findFirst: mocks.studyFindFirst },
    studyProtocolRule: { findMany: mocks.ruleFindMany },
    patientRecord: { findUnique: mocks.patientFindUnique },
    medicalRecord: { findMany: vi.fn(async () => []) },
    researchScreening: { create: mocks.screeningCreate },
  },
}))

vi.mock('../../src/common/llm.js', () => ({
  getApiKey: () => 'test-key',
  deepseekChat: mocks.deepseekChat,
}))

vi.mock('../../src/common/llm-gateway.js', () => ({
  resolveTierModel: () => 'test-model',
}))

vi.mock('../../src/modules/shared/user-context.js', () => ({
  getUserContext: async () => ({ facts: { all: mocks.factsAll } }),
}))

import { screenPatient } from '../../src/modules/research/eligibility-screening.service.js'

beforeEach(() => {
  vi.clearAllMocks()
  // 模拟 DB 归属语义：仅当 where.userId 匹配时才返回研究。
  mocks.studyFindFirst.mockImplementation(async (args: { where?: { id?: string; userId?: string } } = {}) =>
    args.where?.id === 'study-A' && args.where?.userId === 'userA'
      ? { id: 'study-A', name: 'Study A' }
      : null,
  )
  mocks.ruleFindMany.mockResolvedValue([{ id: 'r1', rule: 'age>18', category: 'inclusion', detail: null }])
  mocks.factsAll.mockReturnValue([])
})

describe('P0 Rule 4: screenPatient 拒绝他人研究', () => {
  test('他人 studyId → Study not found，不读规则、不调 LLM、不写筛查', async () => {
    await expect(screenPatient('study-B', 'patient-1', 'userA')).rejects.toThrow('Study not found')

    expect(mocks.studyFindFirst).toHaveBeenCalledWith({ where: { id: 'study-B', userId: 'userA' } })
    expect(mocks.ruleFindMany).not.toHaveBeenCalled()
    expect(mocks.deepseekChat).not.toHaveBeenCalled()
    expect(mocks.screeningCreate).not.toHaveBeenCalled()
  })

  test('自己的 studyId → 正常放行（不误伤）', async () => {
    mocks.deepseekChat.mockResolvedValue(JSON.stringify({ verdict: 'eligible', reason: 'ok', ruleResults: [] }))
    const result = await screenPatient('study-A', 'patient-1', 'userA')
    expect(result.verdict).toBe('eligible')
    expect(mocks.studyFindFirst).toHaveBeenCalledWith({ where: { id: 'study-A', userId: 'userA' } })
    expect(mocks.screeningCreate).toHaveBeenCalledTimes(1)
  })
})
