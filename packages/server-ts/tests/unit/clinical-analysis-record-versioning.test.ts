import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * P0 — 聊天后处理病历覆盖修复。
 *
 * 修复前：直接 update 最新一行；`JSON.parse(existing.sections)` 失败时
 * current={}，只写新键 → 其他章节被清空；且原地改写可能落在医生手写行上。
 * 修复后：合并结果作为新版本行写入（既有行永不修改），基线 JSON 损坏
 * 时中止写入。
 */
const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    medicalRecord: {
      findFirst: mocks.findFirst,
      update: mocks.update,
      create: mocks.create,
    },
  },
}))

import { updateMedicalRecordFromChat } from '../../src/modules/patients/clinical-analysis.js'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.update.mockResolvedValue({})
  mocks.create.mockResolvedValue({})
})

describe('P0 病历版本化写入', () => {
  test('正常合并 → 新行含全部章节（基线保留），绝不原地 update', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'mr_doctor', sections: JSON.stringify({ family_history: '父亲肺癌' }) })

    const ok = await updateMedicalRecordFromChat('u1', 'p1', { diagnosis: 'IIIA 期' })

    expect(ok).toBe(true)
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.create).toHaveBeenCalledTimes(1)
    const sections = JSON.parse(mocks.create.mock.calls[0][0].data.sections)
    expect(sections.family_history).toBe('父亲肺癌')
    expect(sections.diagnosis).toBe('IIIA 期')
    expect(mocks.create.mock.calls[0][0].data.title).toBe('AI 自动更新病历')
  })

  test('基线 sections JSON 损坏 → 中止写入（不清空其他章节）', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'mr1', sections: '{"diagnosis": ' })

    const ok = await updateMedicalRecordFromChat('u1', 'p1', { treatment_plan: '奥希替尼' })

    expect(ok).toBe(false)
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  test('基线不是对象（数组/null）→ 中止写入', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'mr1', sections: '[1,2,3]' })
    expect(await updateMedicalRecordFromChat('u1', 'p1', { diagnosis: 'x' })).toBe(false)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  test('无既有记录 → 直接建首版行', async () => {
    mocks.findFirst.mockResolvedValue(null)
    const ok = await updateMedicalRecordFromChat('u1', 'p1', { chief_complaint: '咳嗽' })
    expect(ok).toBe(true)
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(JSON.parse(mocks.create.mock.calls[0][0].data.sections).chief_complaint).toBe('咳嗽')
  })

  test('无变化 → 不写新版本（避免每轮堆行）；空 sections → 不写', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'mr1', sections: JSON.stringify({ diagnosis: 'IIIA 期' }) })
    expect(await updateMedicalRecordFromChat('u1', 'p1', { diagnosis: 'IIIA 期' })).toBe(false)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(await updateMedicalRecordFromChat('u1', 'p1', {})).toBe(false)
  })
})
