import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { getApp, authHeader } from '../setup.js'
import prisma from '../../src/common/prisma.js'
import { pipelineSettled } from '../../src/modules/files/file-pipeline.service.js'

function buildMultipart(fields: Record<string, string>, file?: { name: string; mime: string; content: Buffer }): { body: Buffer; contentType: string } {
  const boundary = `----testboundary${Date.now()}`
  const chunks: Buffer[] = []
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`))
  }
  if (file) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`))
    chunks.push(file.content)
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

beforeEach(() => {
  process.env.TWIN_BASE_DIR = '.nexus/test-file-dedup'
})

afterEach(async () => {
  delete process.env.TWIN_BASE_DIR
  // 上传触发的后台管线可能仍在写库 — 必须排空后再进入下一文件/断开引擎,
  // 否则与 Prisma query-engine 卸载竞态导致 napi abort(vitest exit 134)。
  await pipelineSettled()
})

/**
 * #730/#619 验收:重复上传同一文件(SHA-256 相同)必须返回 dedup:true 且
 * 不新增文件 — 此前 FileIndex 表缺失,(prisma as any).fileIndex 抛
 * TypeError 被空 catch 吞掉,查重永不命中。
 */
describe('file dedup (#730 FileIndex落地)', () => {
  test('同一内容二次上传 → dedup:true,不新增 FileIndex 行', async () => {
    const app = await getApp()
    const content = Buffer.from('ATR inhibitor paper — identical body for dedup check')

    const first = buildMultipart({}, { name: 'atr-paper.txt', mime: 'text/plain', content })
    const up1 = await app.inject({
      method: 'POST', url: '/api/v1/files/upload',
      headers: { ...await authHeader(), 'content-type': first.contentType },
      payload: first.body,
    })
    expect(up1.statusCode).toBe(200)
    const r1 = JSON.parse(up1.payload)
    expect(r1.dedup).toBe(false)

    const second = buildMultipart({}, { name: 'renamed-copy.txt', mime: 'text/plain', content })
    const up2 = await app.inject({
      method: 'POST', url: '/api/v1/files/upload',
      headers: { ...await authHeader(), 'content-type': second.contentType },
      payload: second.body,
    })
    expect(up2.statusCode).toBe(200)
    const r2 = JSON.parse(up2.payload)
    expect(r2.dedup).toBe(true)
    // 指回第一次上传的物理文件
    expect(r2.file_id).toBe(r1.file_id)

    // 索引里只有第一次的行(第二次上传没有新行)
    const countForFile = await prisma.fileIndex.count({ where: { id: r1.file_id } })
    expect(countForFile).toBe(1)
  })

  test('软删后重传同内容 → 允许重新入库(dedup 放行)', async () => {
    const app = await getApp()
    const content = Buffer.from('deleted-then-reuploaded content')

    const up1raw = buildMultipart({}, { name: 'temp.txt', mime: 'text/plain', content })
    const up1 = await app.inject({
      method: 'POST', url: '/api/v1/files/upload',
      headers: { ...await authHeader(), 'content-type': up1raw.contentType },
      payload: up1raw.body,
    })
    const r1 = JSON.parse(up1.payload)
    expect(r1.dedup).toBe(false)

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/files/${r1.file_id}`, headers: await authHeader() })
    expect(del.statusCode).toBe(200)

    const up2raw = buildMultipart({}, { name: 'temp.txt', mime: 'text/plain', content })
    const up2 = await app.inject({
      method: 'POST', url: '/api/v1/files/upload',
      headers: { ...await authHeader(), 'content-type': up2raw.contentType },
      payload: up2raw.body,
    })
    const r2 = JSON.parse(up2.payload)
    expect(r2.dedup).toBe(false) // deletedAt 置位 → 不再视为重复
  })

  test('管线 job 行同步创建且可查询(#747/#733 状态可见)', async () => {
    const app = await getApp()
    const raw = buildMultipart({}, { name: 'pipeline-check.md', mime: 'text/markdown', content: Buffer.from('# pipelinedoc') })
    const up = await app.inject({
      method: 'POST', url: '/api/v1/files/upload',
      headers: { ...await authHeader(), 'content-type': raw.contentType },
      payload: raw.body,
    })
    const { file_id } = JSON.parse(up.payload)
    // fire-and-forget 可能尚未跑完任何 stage,但行本身必须存在
    const jobs = await app.inject({
      method: 'GET', url: '/api/v1/files/pipeline/jobs',
      headers: await authHeader(),
    })
    expect(jobs.statusCode).toBe(200)
    const list = JSON.parse(jobs.payload).jobs as Array<{ fileId: string; stage: string }>
    expect(list.some((j) => j.fileId === file_id)).toBe(true)
  })
})
