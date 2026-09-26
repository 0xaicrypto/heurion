import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * P0 — 入库任务处理的原子抢占。
 *
 * 修复前：findUnique 判 status==='pending' 后整段跑提取/分析/写条目 —
 * 两个并发调用（轮询 + 手动触发/多实例）都会通过检查，分析跑两遍、
 * MedicalRecordEntry 与审批请求双份落库。
 * 修复后：单条 updateMany 抢占 pending → extracting，只有 count===1 的
 * 调用者继续。
 */
const mocks = vi.hoisted(() => {
  const state = {
    job: {
      id: 'ing1',
      userId: 'u1',
      fileId: 'f1',
      fileName: 'note.txt',
      mimeType: 'text/plain',
      patientHash: 'p1',
      studyId: null,
      uploadedBy: 'u1',
      extractedText: '患者主诉咳嗽' as string | null,
      extractedJson: null,
      status: 'pending',
      confidence: null,
      reasoning: null,
      resultPayload: null,
      retryCount: 0,
      failedReason: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  }
  return {
    state,
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    createEntry: vi.fn(),
  }
})

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    ingestionJob: {
      updateMany: mocks.updateMany,
      findUnique: mocks.findUnique,
      update: mocks.update,
    },
  },
}))

vi.mock('../../src/modules/medical-records/medical-record-entry.service.js', () => ({
  createMedicalRecordEntry: mocks.createEntry,
}))

import { processIngestionJob } from '../../src/modules/ingestion/ingestion.service.js'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.job.status = 'pending'
  // 模拟 DB 原子抢占：仅 pending 能拿到。
  mocks.updateMany.mockImplementation(async (args: { where: { id: string; status?: string }; data: Record<string, unknown> }) => {
    const j = mocks.state.job
    if (j.id === args.where.id && (!args.where.status || j.status === args.where.status)) {
      Object.assign(j, args.data)
      return { count: 1 }
    }
    return { count: 0 }
  })
  mocks.findUnique.mockImplementation(async () => ({ ...mocks.state.job }))
  mocks.update.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    Object.assign(mocks.state.job, args.data)
    return { ...mocks.state.job }
  })
  mocks.createEntry.mockResolvedValue({ id: 'mre1' })
})

describe('P0 入库任务原子抢占', () => {
  test('并发两次 process → 分析只跑一遍，条目只落一份', async () => {
    const results = await Promise.all([processIngestionJob('ing1'), processIngestionJob('ing1')])

    expect(mocks.createEntry).toHaveBeenCalledTimes(1)
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ing1', status: 'pending' },
    }))
    expect(mocks.state.job.status).toBe('awaiting_review')
    // 两个调用都拿到序列化结果（一个完成、一个观察当前态）
    expect(results.every((r) => r.id === 'ing1')).toBe(true)
  })

  test('非 pending 任务不再重复处理（幂等返回当前态）', async () => {
    mocks.state.job.status = 'completed'
    const res = await processIngestionJob('ing1')
    expect(res.status).toBe('completed')
    expect(mocks.createEntry).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  test('任务不存在 → 报错', async () => {
    mocks.findUnique.mockResolvedValue(null)
    mocks.updateMany.mockResolvedValue({ count: 0 })
    await expect(processIngestionJob('missing')).rejects.toThrow('Job not found')
  })
})
