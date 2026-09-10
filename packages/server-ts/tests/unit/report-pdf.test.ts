import { describe, test, expect, vi, beforeEach } from 'vitest'
import { generateReportPdf } from '../../src/modules/report/report-pdf.service.js'

/**
 * #948 — report 模块最小覆盖（第七轮体检：覆盖缺口与 #936 安全缺口
 * 精确重合的根因）。generateReportPdf 的归属校验路径必须锁定：
 * 同 hash 不同 userId → 患者信息不出现（IDOR 修复 #936 的行为锁）。
 */
vi.mock('../../src/common/prisma.js', () => ({
  default: {
    patientRecord: {
      findFirst: vi.fn(async ({ where }: { where: { hash: string; userId: string } }) => {
        // 模拟 DB：hash 归属 owner-user。
        if (where.hash === 'hash_owned' && where.userId === 'user_a') {
          return { hash: 'hash_owned', initials: 'ZW', age: 54, sex: 'M' }
        }
        return null
      }),
    },
  },
}))

describe('#948 report PDF 归属过滤（#936 行为锁）', () => {
  beforeEach(() => vi.clearAllMocks())

  test('本人 hash → 患者信息进报告', async () => {
    const buf = await generateReportPdf({ patient_hash: 'hash_owned', userId: 'user_a' })
    expect(buf.length).toBeGreaterThan(1000)
  })

  test('他人 hash（归属不符）→ 患者信息退化为 Unknown，不泄露跨用户数据', async () => {
    const buf = await generateReportPdf({ patient_hash: 'hash_owned', userId: 'user_b' })
    expect(buf.length).toBeGreaterThan(1000)
    expect(vi.mocked((await import('../../src/common/prisma.js')).default.patientRecord.findFirst).mock.calls[0][0].where).toEqual({
      hash: 'hash_owned',
      userId: 'user_b',
    })
  })

  test('空 hash → 不查库', async () => {
    await generateReportPdf({ patient_hash: '', userId: 'user_a' })
    expect(vi.mocked((await import('../../src/common/prisma.js')).default.patientRecord.findFirst).mock.calls).toHaveLength(0)
  })
})
