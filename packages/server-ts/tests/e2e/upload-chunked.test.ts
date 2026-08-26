import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { getApp, authHeader, getAuthUserId } from '../setup.js'
import { pipelineSettled } from '../../src/modules/files/file-pipeline.service.js'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

function buildMultipart(fields: Record<string, string>, file?: { name: string; mime: string; content: Buffer }): { body: Buffer; contentType: string } {
  const boundary = `----chunktest${Date.now()}${Math.random().toString(36).slice(2, 8)}`
  const chunks: Buffer[] = []

  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`))
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
      ),
    )
    chunks.push(file.content)
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

const UPLOAD_ID = 'up_test_12345678'

async function uploadChunks(app: any, uploadId: string, content: Buffer, total: number) {
  for (let i = 0; i < total; i++) {
    const size = 8
    const chunk = content.subarray(i * size, Math.min((i + 1) * size, content.length))
    const form = buildMultipart({ upload_id: uploadId, index: String(i + 1), total: String(total) }, { name: 'big.txt', mime: 'text/plain', content: chunk })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload-chunk',
      headers: { ...await authHeader(), 'content-type': form.contentType },
      payload: form.body,
    })
    expect(res.statusCode).toBe(200)
  }
}

let userId: string

beforeEach(async () => {
  process.env.TWIN_BASE_DIR = '.nexus/test-upload-chunked'
  userId = await getAuthUserId()
})

afterEach(async () => {
  delete process.env.TWIN_BASE_DIR
  // 上传触发的后台管线可能仍在写库 — 必须排空后再进入下一文件/断开引擎,
  // 否则与 Prisma query-engine 卸载竞态导致 napi abort(vitest exit 134)。
  await pipelineSettled()
})

describe('#fix 分片上传 upload-chunk / upload-complete / upload-abort', () => {
  test('3 个分片上传 → complete 合并落盘 + 文件索引 + 去重响应', async () => {
    const app = await getApp()
    const content = Buffer.from('012345678901234567890123', 'utf-8') // 24 bytes → 3 × 8B
    await uploadChunks(app, UPLOAD_ID, content, 3)

    const done = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload-complete',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { upload_id: UPLOAD_ID, filename: 'big.txt', total: 3, mime: 'text/plain' },
    })
    expect(done.statusCode).toBe(200)
    const body = JSON.parse(done.payload)
    expect(body.dedup).toBe(false)
    expect(body.file_id).toMatch(/^\d+_big\.txt$/)
    expect(body.size_bytes).toBe(content.length)
    expect(body.name).toBe('big.txt')

    const filepath = path.join(process.env.TWIN_BASE_DIR!, userId, 'uploads', body.file_id)
    expect(fs.readFileSync(filepath)).toEqual(content)
    // 分片临时目录已清理(空 .tmp 父目录保留无害,不进入文件列表)。
    expect(fs.existsSync(path.join(process.env.TWIN_BASE_DIR!, userId, 'uploads', '.tmp', UPLOAD_ID))).toBe(false)

    // 相同内容再传一次 → 无 FileIndex 表(测试库)时各自落盘、不互相覆盖;
    // 生产库存在 FileIndex 时由 findDedup 返回 dedup:true(与单次上传同口径)。
    const uploadId2 = 'up_test_87654321'
    await uploadChunks(app, uploadId2, content, 3)
    const dedup = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload-complete',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { upload_id: uploadId2, filename: 'big.txt', total: 3, mime: 'text/plain' },
    })
    expect(dedup.statusCode).toBe(200)
    const dedupBody = JSON.parse(dedup.payload)
    expect(dedupBody.file_id).toMatch(/^\d+_big\.txt$/)
    if (dedupBody.dedup) {
      expect(dedupBody.file_id).toBe(body.file_id)
    } else {
      // 无去重表:两个文件都存在且内容一致。
      expect(fs.readFileSync(path.join(process.env.TWIN_BASE_DIR!, userId, 'uploads', dedupBody.file_id))).toEqual(content)
    }
  })

  test('分片缺失 → 400,不落盘', async () => {
    const app = await getApp()
    await uploadChunks(app, UPLOAD_ID, Buffer.from('only-one-chunk', 'utf-8'), 1)

    const done = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload-complete',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { upload_id: UPLOAD_ID, filename: 'big.txt', total: 3, mime: 'text/plain' },
    })
    expect(done.statusCode).toBe(400)
    expect(JSON.parse(done.payload).error).toContain('Missing chunk 2/3')
    // 未 complete 的分片目录不进入文件列表。
    const list = await app.inject({ method: 'GET', url: '/api/v1/files', headers: await authHeader() })
    const files = JSON.parse(list.payload).files
    expect(files.some((f: any) => f.name.includes('.tmp'))).toBe(false)
  })

  test('非法 upload_id(路径穿越尝试)→ 400', async () => {
    const app = await getApp()
    const form = buildMultipart({ upload_id: '../../evil', index: '1', total: '1' }, { name: 'x.txt', mime: 'text/plain', content: Buffer.from('x') })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload-chunk',
      headers: { ...await authHeader(), 'content-type': form.contentType },
      payload: form.body,
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).error).toContain('Invalid upload_id')
  })

  test('upload-abort 清理已传分片', async () => {
    const app = await getApp()
    await uploadChunks(app, UPLOAD_ID, Buffer.from('0123456789012345', 'utf-8'), 2)
    const tmpDir = path.join(process.env.TWIN_BASE_DIR!, userId, 'uploads', '.tmp', UPLOAD_ID)
    expect(fs.existsSync(tmpDir)).toBe(true)

    const abort = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload-abort',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { upload_id: UPLOAD_ID },
    })
    expect(abort.statusCode).toBe(200)
    expect(fs.existsSync(tmpDir)).toBe(false)
  })

  test('合并文件 sha256 与逐块一致,落盘内容完整', async () => {
    const app = await getApp()
    const content = crypto.randomBytes(24)
    await uploadChunks(app, UPLOAD_ID, content, 3)
    const done = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload-complete',
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { upload_id: UPLOAD_ID, filename: 'big.txt', total: 3, mime: 'text/plain' },
    })
    expect(done.statusCode).toBe(200)
    const body = JSON.parse(done.payload)
    expect(body.file_id).toMatch(/^\d+_big\.txt$/)
    const onDisk = fs.readFileSync(path.join(process.env.TWIN_BASE_DIR!, userId, 'uploads', body.file_id))
    expect(onDisk).toEqual(content)
    expect(crypto.createHash('sha256').update(onDisk).digest('hex')).toBe(crypto.createHash('sha256').update(content).digest('hex'))
  })
})
