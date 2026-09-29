import { describe, test, expect, vi, afterEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import path from 'path'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'
import { uploadsBaseDir } from '../../src/lib/upload-path.js'

/**
 * #1146 — 患者删除:四条 deleteMany 此前串行,中途失败留下半删状态;
 * uploads 下的物理文件(PHI)从不 unlink。修复:单事务 + 提交后 unlink。
 */
async function registerPatient(): Promise<string> {
  const app = await getApp()
  const headers = { ...(await authHeader()), 'content-type': 'application/json' }
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/dicom/patients/register-manual',
    headers,
    payload: { initials: 'PT', age: 50, sex: 'M' },
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.payload).patient_hash
}

/** 建 FileIndex 行 + 对应物理文件（uploadsBaseDir/<fileIndex.id>）。 */
async function seedFile(userId: string, patientHash: string): Promise<{ fileId: string; filePath: string }> {
  const fileId = `fi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const dir = uploadsBaseDir(userId)
  mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, fileId)
  writeFileSync(filePath, 'phi-bytes')
  const now = new Date().toISOString()
  await prisma.fileIndex.create({
    data: {
      id: fileId,
      userId,
      sha256: `sha_${fileId}`,
      name: 'scan.dcm',
      mime: 'application/dicom',
      sizeBytes: 9,
      patientHash,
      createdAt: now,
      updatedAt: now,
    },
  })
  return { fileId, filePath }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('#1146 患者删除', () => {
  test('关联行删除 + 物理文件 unlink（PHI 不残留磁盘）', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const patientHash = await registerPatient()
    const { fileId, filePath } = await seedFile(userId, patientHash)

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/dicom/patients/${patientHash}`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.deleted).toBe(true)
    expect(body.files_deleted).toBe(1)

    expect(existsSync(filePath)).toBe(false)
    expect(await prisma.fileIndex.findUnique({ where: { id: fileId } })).toBeNull()
    expect(await prisma.patientRecord.findFirst({ where: { hash: patientHash, userId } })).toBeNull()
  })

  test('四条删除走单个 Prisma 事务（修复前为串行 await，失败留半删）', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const patientHash = await registerPatient()

    const txSpy = vi.spyOn(prisma, '$transaction')
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/dicom/patients/${patientHash}`,
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)

    expect(txSpy).toHaveBeenCalledTimes(1)
    const [ops] = txSpy.mock.calls[0] as unknown as [unknown[]]
    expect(Array.isArray(ops)).toBe(true)
    expect(ops.length).toBe(4) // medicalRecord/researchAssessment/fileIndex/patientRecord
    expect(await prisma.patientRecord.findFirst({ where: { hash: patientHash, userId } })).toBeNull()
    txSpy.mockRestore()
  })
})
