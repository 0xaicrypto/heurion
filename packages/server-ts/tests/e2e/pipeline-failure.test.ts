import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { getAuthUserId } from '../setup.js'
import prisma from '../../src/common/prisma.js'
import {
  createAndRunPipeline,
  retryPipelineJob,
  pipelineSettled,
} from '../../src/modules/files/file-pipeline.service.js'

beforeEach(() => {
  process.env.TWIN_BASE_DIR = '.nexus/test-pipeline-failure'
})

afterEach(async () => {
  delete process.env.TWIN_BASE_DIR
  // 排空后台管线,避免与 Prisma query-engine 卸载竞态(vitest exit 134)。
  await pipelineSettled()
})

/**
 * #782 验收:stage 失败必须以行主键持久化 errorStage/errorMessage。
 * 此前 catch 兜底写库用 `where: { id: fileId }`(fileId 是文件标识,不是
 * job cuid)→ 恒 P2025 且被 `.catch(() => {})` 吞掉 — failed 状态永不可达,
 * retryPipelineJob 永远拒绝真实失败的任务。
 *
 * 构造确定性抛错:uploads 路径上放一个目录,statSync 通过(mime 可提取),
 * readFileSync 抛 EISDIR → 命中 executePipeline 的 catch。
 */
describe('file pipeline failure persistence (#782)', () => {
  test('extract 抛错 → stage=failed + errorStage 落库,retry 可放行并再次落库', async () => {
    const userId = await getAuthUserId()
    const fileId = 'eisdir-case.txt'
    const uploadDir = path.join(process.env.TWIN_BASE_DIR!, userId, 'uploads')
    // 目录而非文件:statSync 成功、readFileSync 抛 EISDIR
    fs.mkdirSync(path.join(uploadDir, fileId), { recursive: true })

    await createAndRunPipeline({
      userId,
      fileId,
      fileName: 'note.txt',
      mimeType: 'text/plain',
      sha256: 'x'.repeat(64),
      sizeBytes: 42,
      patientHash: null,
    })
    await pipelineSettled()

    const row = await prisma.filePipelineJob.findUnique({
      where: { userId_fileId: { userId, fileId } },
    })
    expect(row).not.toBeNull()
    expect(row!.stage).toBe('failed')
    expect(row!.errorStage).toBe('extract')
    expect(row!.errorMessage).toBeTruthy()

    // failed 是可重试状态:retry 放行 → queued → 后台再次失败 → 仍 failed
    const retry = await retryPipelineJob(userId, row!.id)
    expect(retry.ok).toBe(true)
    const queued = await prisma.filePipelineJob.findUnique({ where: { id: row!.id } })
    expect(queued!.stage).toBe('queued')

    await pipelineSettled()
    const after = await prisma.filePipelineJob.findUnique({ where: { id: row!.id } })
    expect(after!.stage).toBe('failed')
    expect(after!.retryCount).toBe(1)
  })
})
