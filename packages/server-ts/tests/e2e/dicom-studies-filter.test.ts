import { describe, test, expect, afterAll } from 'vitest'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'

/**
 * #1104 — 病历跨患者串号(IDOR)回归锁:GET /dicom/patients/:patientHash/studies
 * 此前直接 readdir 用户 uploads 目录(忽略 :patientHash),患者A能看到患者B
 * 的全部影像。修复后按 FileIndex (userId, patientHash) 过滤,只列 .dcm。
 */

const runId = `study-fix-${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const hashA = `patient_${runId}_A`
const hashB = `patient_${runId}_B`

async function seedFileIndex(userId: string, suffix: string, patientHash: string, opts: { mime?: string; name?: string } = {}) {
  return prisma.fileIndex.create({
    data: {
      id: `${runId}_${suffix}`,
      userId,
      sha256: `sha-${runId}-${suffix}`,
      name: opts.name ?? `${suffix}.dcm`,
      mime: opts.mime ?? 'application/dicom',
      sizeBytes: 128,
      patientHash,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  })
}

afterAll(async () => {
  await prisma.fileIndex.deleteMany({ where: { id: { startsWith: runId } } }).catch(() => {})
})

describe('#1104 DICOM studies 按患者过滤', () => {
  test('患者A的 studies 只含 A 的 .dcm(不含 B 的/非 dcm 文件)', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()

    await seedFileIndex(userId, 'a1', hashA)
    await seedFileIndex(userId, 'a2', hashA)
    // 患者 B 的文件 — 不得出现在 A 的列表里
    await seedFileIndex(userId, 'b1', hashB)
    // A 的非 DICOM 文件 — 不算 study
    await seedFileIndex(userId, 'a3', hashA, { mime: 'text/plain', name: 'note.txt' })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/dicom/patients/${hashA}/studies`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const studies = JSON.parse(res.payload)
    expect(Array.isArray(studies)).toBe(true)
    const ids = studies.map((s: any) => s.study_id)
    expect(ids).toHaveLength(2)
    expect(ids.every((id: string) => id.endsWith('a1') || id.endsWith('a2'))).toBe(true)
    // 契约形状不变:study_id / modality / series_count / created_at
    for (const s of studies) {
      expect(s.study_id).toBeTruthy()
      expect(s.modality).toBe('CT')
      expect(s.series_count).toBe(1)
      expect(typeof s.created_at).toBe('string')
    }
  }, 30000)

  test('无 FileIndex 行的历史遗留 patientHash → 空列表(严格优于跨患者串号)', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dicom/patients/patient_st_legacy_nonexistent/studies',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual([])
  }, 30000)
})
