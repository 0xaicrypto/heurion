import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * Rule 4 / P0 — 研究自动筛查跨租户回归。
 *
 * 修复前：auto-screen.service 的 researchStudy.findMany() 全表扫描，
 * 医生 A 新增患者会把筛查写进 B 的研究（B 可见 A 的患者数据）；
 * eligibility-screening 的 findUnique({id}) 也不校验研究归属。
 *
 * 本测试用「模拟 DB 行为」的 prisma mock：where 缺 userId 时返回全库研究，
 * 带 userId 时只返回该用户的研究 — 修复前 findMany 无过滤 → screenPatient
 * 会被 B 的研究调用（fail）；修复后只调用 A 自己的研究（pass）。
 */
const mocks = vi.hoisted(() => ({
  studyFindMany: vi.fn(),
  patientRecordFindFirst: vi.fn(),
  medicalRecordCount: vi.fn(),
  screeningFindFirst: vi.fn(),
  screeningUpdateMany: vi.fn(),
  screenPatient: vi.fn(),
  telemetryRecord: vi.fn(),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    researchStudy: { findMany: mocks.studyFindMany },
    patientRecord: { findFirst: mocks.patientRecordFindFirst },
    medicalRecord: { count: mocks.medicalRecordCount },
    researchScreening: { findFirst: mocks.screeningFindFirst, updateMany: mocks.screeningUpdateMany },
  },
}))

vi.mock('../../src/modules/research/eligibility-screening.service.js', () => ({
  screenPatient: mocks.screenPatient,
}))

vi.mock('../../src/modules/knowledge/telemetry.service.js', () => ({
  PrismaTelemetryService: class {
    record = mocks.telemetryRecord
  },
}))

import { autoScreenPatient } from '../../src/modules/research/auto-screen.service.js'
import fs from 'fs'
import path from 'path'

// 全库研究（模拟真实表内容）：A 与 B 各一个。
const ALL_STUDIES = [
  { id: 'study-A', userId: 'userA' },
  { id: 'study-B', userId: 'userB' },
]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.studyFindMany.mockImplementation(async (args: { where?: { userId?: string } } = {}) => {
    const rows = args.where?.userId ? ALL_STUDIES.filter((s) => s.userId === args.where!.userId) : ALL_STUDIES
    return rows.map((s) => ({ id: s.id }))
  })
  mocks.patientRecordFindFirst.mockResolvedValue({ hash: 'patient-1' })
  mocks.medicalRecordCount.mockResolvedValue(0)
  mocks.screeningFindFirst.mockResolvedValue(null)
  mocks.screeningUpdateMany.mockResolvedValue({ count: 1 })
  mocks.screenPatient.mockImplementation(async (studyId: string) => ({ verdict: 'eligible', reason: `ok ${studyId}` }))
  mocks.telemetryRecord.mockResolvedValue(undefined)
})

describe('P0 Rule 4: autoScreenPatient 只筛查本用户名下的研究', () => {
  test('调研列表查询带 userId，他人研究不得触达 screenPatient/筛查写入', async () => {
    const result = await autoScreenPatient('userA', 'patient-1')

    expect(mocks.studyFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'userA' } }),
    )
    const screenedStudies = mocks.screenPatient.mock.calls.map((c) => c[0])
    expect(screenedStudies).toEqual(['study-A'])
    expect(screenedStudies).not.toContain('study-B')
    // 筛查结论绝不写进他人研究
    for (const call of mocks.screeningUpdateMany.mock.calls) {
      expect(call[0].where.studyId).toBe('study-A')
    }
    expect(result).toEqual({ studies: 1, eligible: 1 })
  })

  test('源级防复发锁：researchStudy 查询必须带 userId（findMany/findFirst/findUnique）', () => {
    const files = [
      'src/modules/research/auto-screen.service.ts',
      'src/modules/research/eligibility-screening.service.ts',
    ]
    for (const rel of files) {
      const src = fs.readFileSync(path.resolve(__dirname, '../../', rel), 'utf8')
      for (const m of src.matchAll(/researchStudy\s*\.\s*(findMany|findFirst|findUnique)\s*\(/g)) {
        const stmt = src.slice(m.index!, m.index! + 400)
        expect(stmt, `${rel}: ${m[0]} 缺 userId 归属过滤`).toMatch(/userId/)
      }
    }
  })
})
